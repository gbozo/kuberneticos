// Display allocation and RFB proxying for the KuberneticOS x-desktop
// integration (plan milestone M2, "server/xdisplay.go").
//
// A central shared X server pod ("kos-xserver") hosts one virtual display
// per kOS window; this file allocates those displays, provisions per-display
// xauth cookies by exec-ing into the pods, launches the GUI command inside
// the app pod and finally proxies the noVNC websocket to the x11vnc TCP
// port (a small websockify clone).
//
// Offline mode never allocates and never mutates: POST/DELETE answer 503
// (the standard errOffline envelope), list/health answer available:false
// and the websocket route rejects the upgrade, mirroring the metrics and
// write-endpoint philosophy.
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/rest"
)

const (
	defaultXDisplayStart    = 21 // Xvfb :21 .. :25 by default
	defaultXDisplayPool     = 5
	defaultXServerNamespace = "kos"
	defaultXServerPod       = "kos-xserver-0"
	defaultXServerService   = "kos-xserver"
	defaultXDisplayTTL      = 12 * time.Hour

	// xdisplayCookieBytes is the xauth key length for MIT-COOKIE-1.
	xdisplayCookieBytes = 16

	// vncBasePort is the RFB listener prefix: display N listens on 5900+N
	// (so :21 → 5921), matching the xserver deployment.
	vncBasePort = 5900

	// xdisplayDialTimeout bounds the TCP dial to the x11vnc listener.
	xdisplayDialTimeout = 3 * time.Second

	// Background sweeper cadence: one expired-session cleanup pass per
	// minute (kill orphaned GUI processes, remove xauth entries, purge the
	// allocation maps).
	xdisplaySweepInterval = time.Minute
	xdisplaySweepTimeout  = time.Minute
)

// xDisplaySession is one allocated window/display. The token is a random
// bearer the browser uses to (re)connect the WS proxy: it must survive a
// browser refresh (so the whole session stays usable) until DELETE or its
// TTL expiry, and it may open multiple websocket streams (reconnect after
// reload) — but only ever to this one display/pod mapping.
type xDisplaySession struct {
	display   int
	token     string
	namespace string
	pod       string
	container string
	command   []string
	app       string
	pid       string
	createdAt time.Time
	expiresAt time.Time
	vncPort   int
}

// xDisplayAllocator is the in-memory registry of active sessions, guarded
// by a mutex. State survives only the server lifetime: if kos-server
// restarts, DISPLAY allocation is stateless (fresh cookie, relaunch), so
// losing the map is acceptable and matches plan §3.1.
type xDisplayAllocator struct {
	mu       sync.Mutex
	start    int
	count    int
	ttl      time.Duration
	sessions map[int]*xDisplaySession    // by display number
	byToken  map[string]*xDisplaySession // by bearer token
}

// newXDisplayAllocator reads the static pool configuration from the
// environment (KOS_XDISPLAY_START / KOS_XDISPLAY_POOL / KOS_XDISPLAY_TTL).
func newXDisplayAllocator() *xDisplayAllocator {
	start := defaultXDisplayStart
	if raw := os.Getenv("KOS_XDISPLAY_START"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			start = n
		}
	}

	count := defaultXDisplayPool
	if raw := os.Getenv("KOS_XDISPLAY_POOL"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			count = n
		}
	}

	ttl := defaultXDisplayTTL
	if raw := os.Getenv("KOS_XDISPLAY_TTL"); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d > 0 {
			ttl = d
		}
	}

	return &xDisplayAllocator{
		start:    start,
		count:    count,
		ttl:      ttl,
		sessions: map[int]*xDisplaySession{},
		byToken:  map[string]*xDisplaySession{},
	}
}

// collectExpired atomically removes every expired session from both maps
// (by display and by token) and returns the removed entries so the sweeper
// can run its side effects (kill+xauth cleanup afterwards) knowing nothing
// else will see them.
func (x *xDisplayAllocator) collectExpired(now time.Time) []xDisplaySession {
	x.mu.Lock()
	defer x.mu.Unlock()

	var expired []xDisplaySession
	for n, s := range x.sessions {
		if now.After(s.expiresAt) {
			delete(x.byToken, s.token)
			delete(x.sessions, n)
			expired = append(expired, *s)
		}
	}
	sort.Slice(expired, func(i, j int) bool { return expired[i].display < expired[j].display })
	return expired
}

// xdisplaySweeper is the background session reaper: on every tick it
// removes expired entries from the allocator, kills the recorded process
// group inside the app pod (else every TTL expiry would leak a running GUI
// process per display) and removes the xauth entries from the xserver pod.
// The interval/now/exec hooks are fields so tests can drive the sweep with
// a fake executor and frozen clocks.
type xdisplaySweeper struct {
	interval time.Duration
	timeout  time.Duration
	now      func() time.Time
	collect  func(now time.Time) []xDisplaySession
	exec     func(ctx context.Context, namespace, pod, container string, command []string, stdin []byte) (string, error)
	release  func(display int)
	xserver  xserverCoord
}

// newXDisplaySweeper wires the sweeper to the real allocator and exec seam.
func newXDisplaySweeper(cfg *rest.Config, alloc *xDisplayAllocator, coord xserverCoord) *xdisplaySweeper {
	return &xdisplaySweeper{
		interval: xdisplaySweepInterval,
		timeout:  xdisplaySweepTimeout,
		now:      time.Now,
		collect:  alloc.collectExpired,
		exec: func(ctx context.Context, namespace, pod, container string, command []string, stdin []byte) (string, error) {
			return execRun(ctx, cfg, namespace, pod, container, command, stdin)
		},
		release: alloc.release,
		xserver: coord,
	}
}

// sweep performs exactly one expired-session cleanup pass. Best effort per
// session: a kill/xauth failure is logged and never blocks the others.
func (s *xdisplaySweeper) sweep(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	for _, session := range s.collect(s.now()) {
		if session.pid != "" {
			if _, err := s.exec(ctx, session.namespace, session.pod, session.container,
				xKillArgs(session.pid), nil); err != nil {
				log.Printf("sweeper: killing pid %s (%s/%s) failed: %v",
					session.pid, session.namespace, session.pod, err)
			}
		}
		if _, err := s.exec(ctx, s.xserver.namespace, s.xserver.pod, "",
			xAuthRemoveArgs(session.display, s.xserver.displayHost()), nil); err != nil {
			log.Printf("sweeper: xauth remove for display :%d failed: %v", session.display, err)
		}
		// collectExpired already purged the maps; release() still runs as
		// the single source of truth for freeing (it is a no-op here).
		s.release(session.display)
	}
}

// run drives sweep() once per interval until ctx is cancelled. Main wires
// this to the shutdown context so the goroutine cannot leak.
func (s *xdisplaySweeper) run(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweep(ctx)
		}
	}
}

// ageOf never renders a negative duration, even if the timestamps are
// produced by different monotonic clocks.
func ageOf(t time.Time) time.Duration {
	if d := time.Since(t); d > 0 {
		return d
	}
	return 0
}

// allocate hands out the lowest free display number.
func (x *xDisplayAllocator) allocate() (int, string, error) {
	x.mu.Lock()
	defer x.mu.Unlock()

	now := time.Now()
	// Lazily drop expired sessions: their browser went away long ago and
	// the app process keeps running orphaned on the display, but nothing
	// references them anymore.
	for n, s := range x.sessions {
		if now.After(s.expiresAt) {
			delete(x.byToken, s.token)
			delete(x.sessions, n)
		}
	}

	display := -1
	for n := x.start; n < x.start+x.count; n++ {
		if _, busy := x.sessions[n]; !busy {
			display = n
			break
		}
	}
	if display == -1 {
		return 0, "", errors.New("no free displays")
	}

	token, err := newXDisplayToken()
	if err != nil {
		return 0, "", fmt.Errorf("generate token: %w", err)
	}

	s := &xDisplaySession{
		display:   display,
		token:     token,
		createdAt: now,
		expiresAt: now.Add(x.ttl),
		vncPort:   vncBasePort + display,
	}
	x.sessions[display] = s
	x.byToken[token] = s
	return display, token, nil
}

// lookup resolves a token to its session, only while it is valid and not
// expired. Used on every websocket upgrade to authorize the proxy; an
// expired entry is purged in passing so tokens do not linger until the
// next full sweep.
func (x *xDisplayAllocator) lookup(token string) (*xDisplaySession, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()

	s, ok := x.byToken[token]
	if !ok {
		return nil, false
	}
	if time.Now().After(s.expiresAt) {
		delete(x.byToken, s.token)
		delete(x.sessions, s.display)
		return nil, false
	}
	return s, true
}

// firstLine returns the trimmed first line of multi-line exec output
// (used to parse the shell PID printed by the launch wrapper).
func firstLine(out string) string {
	if i := strings.IndexByte(out, '\n'); i >= 0 {
		out = out[:i]
	}
	return strings.TrimSpace(out)
}

// lookupByDisplay resolves a display number to its session for DELETE.
func (x *xDisplayAllocator) lookupByDisplay(display int) (*xDisplaySession, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()

	s, ok := x.sessions[display]
	if !ok || time.Now().After(s.expiresAt) {
		return nil, false
	}
	return s, true
}

// release frees a display (after the kill/cleanup execs ran). Idempotent:
// double release is a no-op, matching DELETE-retry semantics.
func (x *xDisplayAllocator) release(display int) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if s, ok := x.sessions[display]; ok {
		delete(x.byToken, s.token)
		delete(x.sessions, display)
	}
}

// list returns the active sessions ordered by display number, skipping
// expired ones for reporting.
func (x *xDisplayAllocator) list(now time.Time) []xDisplaySession {
	x.mu.Lock()
	defer x.mu.Unlock()

	out := make([]xDisplaySession, 0, len(x.sessions))
	for _, s := range x.sessions {
		if now.After(s.expiresAt) {
			continue
		}
		out = append(out, *s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].display < out[j].display })
	return out
}

// newXDisplayToken produces a random URL-safe hex bearer (one per session).
func newXDisplayToken() (string, error) {
	raw := make([]byte, xdisplayCookieBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// newXDisplayCookie is an xauth key: 16 random bytes, hex encoded — the
// exact string both `xauth add` invocations and the XAUTHORITY database
// generated inside the app pod use. Random because a leaked cookie would
// grant X11 access to a whole display.
func newXDisplayCookie() (string, error) {
	return newXDisplayToken()
}

// xserverCoord carries the resolved coordinates of the central X server
// pod (from KOS_XSERVER_* env, defaults matching the deploy manifest).
type xserverCoord struct {
	namespace string
	pod       string
	service   string
}

func (c xserverCoord) displayHost() string {
	// Namespace-qualified service FQDN: resolvable from every cluster pod,
	// so DISPLAY is correct regardless of the app pod's namespace.
	return c.service + "." + c.namespace + ".svc"
}

func newXServerCoord() xserverCoord {
	return xserverCoord{
		namespace: envOrDefault("KOS_XSERVER_NAMESPACE", defaultXServerNamespace),
		pod:       envOrDefault("KOS_XSERVER_POD", defaultXServerPod),
		service:   envOrDefault("KOS_XSERVER_SERVICE", defaultXServerService),
	}
}

func envOrDefault(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

// shellSingleQuote wraps one argument so `sh -c` receives it literally.
func shellSingleQuote(arg string) string {
	return "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
}

// xAuthAddArgs builds the exec that registers the cookie on the X server
// side, against both display naming forms (own-server-local ":N" and the
// namespace-qualified FQDN) so clients connecting either way authenticate.
// Best-effort on the FQDN form: some clusters resolve DNS differently and
// xauth's address handling follows the resolver.
func xAuthAddArgs(display int, host, cookie string) []string {
	script := fmt.Sprintf(
		"xauth add \":%[1]d\" MIT-COOKIE-1 %[2]s; "+
			"xauth add \"%[3]s:%[1]d\" MIT-COOKIE-1 %[2]s 2>/dev/null || true",
		display, cookie, host)
	return []string{"/bin/sh", "-c", script}
}

// xAuthRemoveArgs unregisters the cookie entries on release (best effort).
func xAuthRemoveArgs(display int, host string) []string {
	script := fmt.Sprintf(
		"xauth remove \":%[1]d\" 2>/dev/null; "+
			"xauth remove \"%[2]s:%[1]d\" 2>/dev/null; true",
		display, host)
	return []string{"/bin/sh", "-c", script}
}

// xLaunchScript builds the shell program exec-ed into the app pod:
//  1. read the base64 blob piped through the exec stdin (the cookie is a
//     secret and must not linger in argv/ps output; `read -r` with the
//     `[ -n "$COOKIE" ]` fallback tolerates a final line without a newline,
//     which is how some exec transports deliver the single-line body);
//  2. decode it and let `xauth -f` build a real Xauthority database for
//     the FQDN display name (falling back to the bare ":N" form);
//  3. start the GUI command in the background via setsid — as the fresh
//     session leader its PID equals its process group ID, which is what
//     DELETE must kill (`kill -TERM -PID`). The wrapper exits 0 right
//     away so the request returns instead of blocking until the app
//     quits; the GUI holds DISPLAY/XAUTHORITY and survives the wrapper;
//  4. $! (the setsid leader PID) is echoed as the single stdout line.
func xLaunchScript(host string, display int, xauthPath string, command []string) string {
	quoted := make([]string, len(command))
	for i, arg := range command {
		quoted[i] = shellSingleQuote(arg)
	}
	return fmt.Sprintf(`read -r COOKIE || [ -n "$COOKIE" ] || exit 97
HEX=$(printf %%s "$COOKIE" | base64 -d) || exit 98
xauth -f %[4]s add %[2]s:%[1]d MIT-COOKIE-1 "$HEX" 2>/dev/null || xauth -f %[4]s add :%[1]d MIT-COOKIE-1 "$HEX" || exit 99
setsid env DISPLAY=%[2]s:%[1]d XAUTHORITY=%[4]s %[3]s </dev/null >/dev/null 2>&1 & echo $!
exit 0`,
		display, host, strings.Join(quoted, " "), xauthPath)
}

// xLaunchStdin builds the launch exec's exact stdin: the base64 cookie
// (secret — never argv) followed by a terminating newline so `read -r` at
// EOF succeeds. The launch script additionally tolerates the missing
// newline for transports that trim it.
func xLaunchStdin(cookie string) []byte {
	return []byte(base64.StdEncoding.EncodeToString([]byte(cookie)) + "\n")
}

// xKillArgs terminates the recorded process group (TERM, then a short
// kill -0 wait loop, then KILL in case the app ignored TERM) via the app
// pod. The launch wrapper runs the GUI under setsid, so the recorded PID
// is also the process group ID; `kill -PID` signals the whole group, not
// just the leader.
func xKillArgs(pid string) []string {
	script := fmt.Sprintf(`kill -TERM -%[1]s 2>/dev/null; i=0; while [ $i -lt 5 ] && kill -0 -%[1]s 2>/dev/null; do sleep 0.1; i=$((i+1)); done; kill -KILL -%[1]s 2>/dev/null; true`, pid)
	return []string{"/bin/sh", "-c", script}
}

// parsePID extracts the session PID printed by the launch wrapper.
func parsePID(out string) (string, error) {
	line := firstLine(out)
	pid, err := strconv.Atoi(line)
	if err != nil || pid <= 0 {
		return "", fmt.Errorf("launch output did not contain a PID: %q", firstLine(out))
	}
	return strconv.Itoa(pid), nil
}

// xauthPath is the per-display cookie file inside the app pod.
func xauthPath(display int) string {
	return fmt.Sprintf("/tmp/.kos-xauth-%d", display)
}

// xDisplayRequest is the POST /api/xdisplay body.
type xDisplayRequest struct {
	Cluster   string   `json:"cluster,omitempty"`
	Namespace string   `json:"namespace"`
	Pod       string   `json:"pod"`
	Container string   `json:"container,omitempty"`
	App       string   `json:"app,omitempty"`
	Command   []string `json:"command"`
}

// xDisplayResponse is the POST /api/xdisplay success body.
type xDisplayResponse struct {
	Source  string `json:"source"`
	Display int    `json:"display"`
	Token   string `json:"token"`
	WSPath  string `json:"wsPath"`
}

// handleXDisplayCreate allocates a display, provisions the cookie in the
// xserver pod, launches the command inside the app pod and records the
// session.
func (a *api) handleXDisplayCreate(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "read body: " + err.Error()})
		return
	}
	var req xDisplayRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid JSON body"})
		return
	}

	// Parameter validation mirrors the write endpoints: 400 before any
	// cluster/offline decision, so a bad request stays a 400 in offline
	// mode too. Names must be well-formed RFC 1123 labels — they are
	// interpolated into API paths by the exec calls below.
	switch {
	case req.Namespace == "":
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required field: namespace"})
		return
	case req.Pod == "":
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required field: pod"})
		return
	case len(req.Command) == 0:
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required field: command"})
		return
	case !isK8sName(req.Namespace):
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid namespace"})
		return
	case !isK8sName(req.Pod):
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid pod"})
		return
	case req.Container != "" && !isK8sName(req.Container):
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid container"})
		return
	}

	if a.clientset == nil || a.restConfig == nil {
		writeError(w, errOffline)
		return
	}

	coord := newXServerCoord()

	display, token, err := a.xdisplay.allocate()
	if err != nil {
		// Pool exhaustion is a capacity problem, not a bug: 503 like
		// offline mode.
		writeJSON(w, http.StatusServiceUnavailable, errorResponse{Error: err.Error()})
		return
	}
	released := false
	release := func() {
		if !released {
			released = true
			a.xdisplay.release(display)
		}
	}
	defer release()

	// 1) Register the cookie on the X server (system Xauthority managed by
	// the xserver deployment).
	cookie, err := newXDisplayCookie()
	if err != nil {
		log.Printf("xdisplay: cookie generation failed: %v", err)
		writeError(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if _, err := execRun(ctx, a.restConfig, coord.namespace, coord.pod, "",
		xAuthAddArgs(display, coord.displayHost(), cookie), nil); err != nil {
		log.Printf("xdisplay: xauth add on %s/%s failed: %v", coord.namespace, coord.pod, err)
		writeError(w, err)
		return
	}

	// 2) Launch the command in the app pod; the cookie travels on exec
	// stdin (newline-terminated, see xLaunchStdin) so it never shows in
	// argv. stdout's single line is the setsid leader PID. The wrapper
	// backgrounds the GUI and exits 0, so this exec returns promptly.
	script := xLaunchScript(coord.displayHost(), display, xauthPath(display), req.Command)
	out, err := execRun(ctx, a.restConfig, req.Namespace, req.Pod, req.Container,
		[]string{"/bin/sh", "-c", script}, xLaunchStdin(cookie))
	if err != nil {
		log.Printf("xdisplay: launch in %s/%s failed: %v", req.Namespace, req.Pod, err)
		writeError(w, err)
		return
	}
	pid, err := parsePID(out)
	if err != nil {
		log.Printf("xdisplay: launch in %s/%s produced no PID: %v", req.Namespace, req.Pod, err)
		writeError(w, err)
		return
	}

	// 3) Record the session and answer.
	a.xdisplay.record(display, token, req, pid)
	writeJSON(w, http.StatusOK, xDisplayResponse{
		Source:  a.source,
		Display: display,
		Token:   token,
		WSPath:  "/api/xdisplay/ws?token=" + token,
	})
}

// record attaches the launch details to a freshly allocated session.
func (x *xDisplayAllocator) record(display int, token string, req xDisplayRequest, pid string) {
	x.mu.Lock()
	defer x.mu.Unlock()

	s := x.sessions[display]
	if s == nil {
		return
	}
	if s.token != token {
		// Released and re-allocated underneath us — a pathological race
		// that must not corrupt the newer session.
		return
	}
	s.namespace = req.Namespace
	s.pod = req.Pod
	s.container = req.Container
	s.command = req.Command
	s.app = req.App
	if s.app == "" {
		s.app = req.Pod
	}
	s.pid = pid
}

// handleXDisplayDelete kills the recorded app-process PID via exec, then
// frees the display and cleans up the cookie files (best effort). Accepts
// token= or display= so a browser that lost the token can still release.
func (a *api) handleXDisplayDelete(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	token := query.Get("token")
	displayStr := query.Get("display")
	if token == "" && displayStr == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required query parameter: token (or display)"})
		return
	}
	display := -1
	if displayStr != "" {
		n, err := strconv.Atoi(displayStr)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid display"})
			return
		}
		display = n
	}

	if a.clientset == nil || a.restConfig == nil {
		writeError(w, errOffline)
		return
	}

	session, ok := a.findSession(token, display)
	if !ok {
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "unknown or expired display session"})
		return
	}

	// Kill the GUI process group leader inside the app pod. Any error is
	// logged but the display is still freed: keeping a leaked allocation
	// locked forever because the pod is already gone would be worse.
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if session.pid != "" {
		if _, err := execRun(ctx, a.restConfig, session.namespace, session.pod, session.container,
			xKillArgs(session.pid), nil); err != nil {
			log.Printf("xdisplay: killing pid %s in %s/%s failed: %v", session.pid, session.namespace, session.pod, err)
		}
	}

	// Best-effort cleanup: drop the cookie file in the app pod and the
	// xauth entries on the server.
	if _, err := execRun(ctx, a.restConfig, session.namespace, session.pod, session.container,
		[]string{"/bin/sh", "-c", "rm -f " + shellSingleQuote(xauthPath(session.display))}, nil); err != nil {
		log.Printf("xdisplay: cookie cleanup in %s/%s failed: %v", session.namespace, session.pod, err)
	}
	if _, err := execRun(ctx, a.restConfig, newXServerCoord().namespace, newXServerCoord().pod, "",
		xAuthRemoveArgs(session.display, newXServerCoord().displayHost()), nil); err != nil {
		log.Printf("xdisplay: xauth remove failed: %v", err)
	}

	a.xdisplay.release(session.display)

	writeJSON(w, http.StatusOK, actionResponse{
		Source:  a.source,
		OK:      true,
		Message: fmt.Sprintf("Released display :%d", session.display),
	})
}

// findSession resolves token= display= to one active session.
func (a *api) findSession(token string, display int) (*xDisplaySession, bool) {
	if token != "" {
		return a.xdisplay.lookup(token)
	}
	return a.xdisplay.lookupByDisplay(display)
}

// xDisplayListItem is one entry of GET /api/xdisplay/list.
type xDisplayListItem struct {
	Display    int    `json:"display"`
	App        string `json:"app"`
	Pod        string `json:"pod"`
	Namespace  string `json:"namespace"`
	Container  string `json:"container,omitempty"`
	CreatedAt  string `json:"createdAt"`
	SessionAge int64  `json:"sessionAge"`
}

// xDisplayListResponse carries availability like the metrics endpoints so
// "no displays configured" is never a 5xx.
type xDisplayListResponse struct {
	Source    string             `json:"source"`
	Available bool               `json:"available"`
	Displays  []xDisplayListItem `json:"displays"`
}

// handleXDisplayList reports active sessions (used by the frontend to
// reconnect after a browser reload).
func (a *api) handleXDisplayList(w http.ResponseWriter, r *http.Request) {
	if a.clientset == nil || a.xdisplay == nil {
		writeJSON(w, http.StatusOK, xDisplayListResponse{Source: a.source, Displays: []xDisplayListItem{}})
		return
	}

	now := time.Now().UTC()
	sessions := a.xdisplay.list(now)
	items := make([]xDisplayListItem, 0, len(sessions))
	for i := range sessions {
		s := &sessions[i]
		items = append(items, xDisplayListItem{
			Display:    s.display,
			App:        s.app,
			Pod:        s.pod,
			Namespace:  s.namespace,
			Container:  s.container,
			CreatedAt:  s.createdAt.UTC().Format(time.RFC3339),
			SessionAge: int64(ageOf(s.createdAt) / time.Second),
		})
	}
	writeJSON(w, http.StatusOK, xDisplayListResponse{Source: a.source, Available: true, Displays: items})
}

// xDisplayHealthResponse mirrors the metrics-availability envelope.
type xDisplayHealthResponse struct {
	Source    string `json:"source"`
	Available bool   `json:"available"`
}

// handleXDisplayHealth checks the xserver pod two ways: it must exist, and
// the RFB port for the pool's first display must accept a TCP dial. Only
// the cheap pod get is done when the pod is missing — no point dialing.
func (a *api) handleXDisplayHealth(w http.ResponseWriter, r *http.Request) {
	if a.clientset == nil || a.xdisplay == nil {
		writeJSON(w, http.StatusOK, xDisplayHealthResponse{Source: a.source})
		return
	}

	coord := newXServerCoord()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	pod, err := a.clientset.CoreV1().Pods(coord.namespace).Get(ctx, coord.pod, metav1.GetOptions{})
	if err != nil {
		// Pod missing/unreachable → available:false with HTTP 200 (probe,
		// not an error the browser must surface as red).
		writeJSON(w, http.StatusOK, xDisplayHealthResponse{Source: a.source})
		return
	}
	if pod.Status.PodIP == "" {
		writeJSON(w, http.StatusOK, xDisplayHealthResponse{Source: a.source})
		return
	}

	addr := net.JoinHostPort(pod.Status.PodIP, strconv.Itoa(vncBasePort+a.xdisplay.start))
	conn, err := net.DialTimeout("tcp", addr, xdisplayDialTimeout)
	if err != nil {
		writeJSON(w, http.StatusOK, xDisplayHealthResponse{Source: a.source})
		return
	}
	_ = conn.Close()
	writeJSON(w, http.StatusOK, xDisplayHealthResponse{Source: a.source, Available: true})
}

// closeWSWithReason reports a failure that happened after the upgrade: the
// HTTP status is already gone (the handshake switched protocols), so a WS
// close control frame is the only channel left for the client; the real
// reason is always logged server-side.
func closeWSWithReason(conn *websocket.Conn, code int, reason string) {
	log.Printf("xdisplay: websocket session failed: %s", reason)
	_ = conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(code, reason), time.Now().Add(wsWriteTimeout))
}

// handleXDisplayWS upgrades to websocket and proxies binary frames to the
// x11vnc TCP listener of the session's display (websockify pattern).
// The token is validated on every upgrade: it may reconnect (browser
// refresh) until TTL/DELETE, but each stream is two goroutines copying
// frames and picking up none of the session state after authorization —
// the cookie and target pod never cross the browser boundary.
func (a *api) handleXDisplayWS(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required query parameter: token"})
		return
	}
	if a.clientset == nil || a.restConfig == nil {
		writeError(w, errOffline)
		return
	}
	session, ok := a.xdisplay.lookup(token)
	if !ok {
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "unknown or expired display token"})
		return
	}

	// Everything the request must learn through HTTP JSON happens BEFORE
	// the upgrade — status codes die with the handshake. The pod get is
	// cheap enough to hoist so a missing/unready xserver pod is an
	// ordinary error response, not a post-upgrade mystery.
	coord := newXServerCoord()
	podGetCtx, cancelPodGet := context.WithTimeout(r.Context(), 10*time.Second)
	pod, err := a.clientset.CoreV1().Pods(coord.namespace).Get(podGetCtx, coord.pod, metav1.GetOptions{})
	cancelPodGet()
	if err != nil {
		writeError(w, err)
		return
	}

	// Upgrade AFTER authorization and the cheap reachability checks.
	conn, err := wsUpgrader().Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already wrote the failure response.
	}
	defer conn.Close()

	if pod.Status.PodIP == "" {
		closeWSWithReason(conn, websocket.CloseTryAgainLater, "xserver pod has no IP")
		return
	}

	addr := net.JoinHostPort(pod.Status.PodIP, strconv.Itoa(session.vncPort))
	upstream, err := net.DialTimeout("tcp", addr, xdisplayDialTimeout)
	if err != nil {
		closeWSWithReason(conn, websocket.CloseTryAgainLater, "dial x11vnc: "+err.Error())
		return
	}
	defer upstream.Close()
	proxyRFB(conn, upstream, idleTimeout())
}

// proxyRFB copies binary frames between the browser websocket and the
// cluster TCP connection. One goroutine reads TCP→WS (through the pump so
// writes stay single-writer), the handler goroutine reads WS→TCP. Both
// sides close both directions on any error; pings ride on the pump.
func proxyRFB(conn *websocket.Conn, upstream net.Conn, idle time.Duration) {
	frames := make(chan wsOutbound, 32)

	// Handler/deadline installation happens here, BEFORE the pump starts:
	// wsPump never touches handlers (single owner rule), and both parties
	// would race if these were installed after the pump goroutine started.
	// Pong/ping frames reset the read deadline instead of surfacing as
	// protocol errors, and every refresh also pushes the deadline onto the
	// upstream TCP leg so an otherwise-idle x11vnc connection stays alive
	// as long as the browser does.
	idleRefresh := func() {
		conn.SetReadDeadline(time.Now().Add(idle))
		_ = upstream.SetDeadline(time.Now().Add(idle))
	}
	installWSHandlers(conn, idle, func() {
		_ = upstream.SetDeadline(time.Now().Add(idle))
	})

	wsPumpDone := make(chan struct{})
	go func() {
		defer close(wsPumpDone)
		wsPump(conn, frames, idle)
	}()

	// TCP → websocket: upstream data is opaque binary (RFB) and flows
	// straight into the pump. The upstream Read buffer is copied per
	// chunk, so a large RFB message arriving across reads is forwarded
	// frame-by-frame as it lands.
	go func() {
		defer close(frames)
		buf := make([]byte, 4096)
		for {
			n, err := upstream.Read(buf)
			if n > 0 {
				chunk := make([]byte, n)
				copy(chunk, buf[:n])
				if _, werr := upstreamFrames(frames, chunk); werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	// websocket → TCP: the RFB protocol only sends binary on this leg;
	// anything else from a browser client would violate it, so it closes
	// the proxy. Data frames refresh the deadlines too (same hook as the
	// handlers, kept explicit here for the upstream leg).
	conn.SetReadDeadline(time.Now().Add(idle))
	upstream.SetDeadline(time.Now().Add(idle))

	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if mt == websocket.BinaryMessage && len(data) > 0 {
			idleRefresh()
			if _, err := upstream.Write(data); err != nil {
				break
			}
		}
	}

	upstream.Close()
	<-wsPumpDone
}

// upstreamFrames feeds one upstream chunk into the pump; the helper keeps
// the ping/pong… style send discipline in one place.
func upstreamFrames(frames chan<- wsOutbound, chunk []byte) (int, error) {
	select {
	case frames <- wsOutbound{data: chunk, isBin: true}:
		return len(chunk), nil
	case <-time.After(wsWriteTimeout):
		return 0, errors.New("pump stalled")
	}
}
