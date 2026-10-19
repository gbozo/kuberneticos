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
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	urlpkg "net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/httpstream"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/portforward"
	spdy "k8s.io/client-go/transport/spdy"
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

	// xdisplayDialTimeout bounds the TCP dial to the x11vnc listener
	// (direct mode only; in-cluster kos-server deployments get the cheaper
	// direct route to a node-local pod IP).
	xdisplayDialTimeout = 3 * time.Second

	// envXDisplayDialer selects how the RFB proxy reaches the x11vnc
	// listener: "portfw" (default) tunnels the TCP stream through the
	// Kubernetes API server port-forward subresource — required when
	// kos-server runs OUTSIDE the cluster (apiserver tunnel, no pod-IP
	// route); "direct" dials podIP:5900+N as before.
	envXDisplayDialer = "KOS_XDISPLAY_DIALER"

	// xdisplayPortFwDialTimeout bounds the whole port-forward dial
	// sequence (apiserver request upgrade + data/error stream setup),
	// which traverses the tunnel/apiserver and is slower than a local TCP
	// connect.
	xdisplayPortFwDialTimeout = 10 * time.Second

	// Background sweeper cadence: one expired-session cleanup pass per
	// minute (kill orphaned GUI processes, remove xauth entries, purge the
	// allocation maps).
	xdisplaySweepInterval = time.Minute
	xdisplaySweepTimeout  = time.Minute

	// Idle-grace safety net against leaked allocations: when a token's
	// websocket ends without the DELETE racing in (browser killed without
	// unmount cleanup, tab crash, dev-server reload, a static screen
	// idling into the stream idle timeout + retry churn), the display
	// would stay pinned until the 12h TTL. Instead, once the stream is
	// gone and stays gone — no newer stream re-opened, see wsGen — for
	// defaultXDisplayWSGrace, the session is torn down (app killed, auth
	// cleaned, display freed). Env: KOS_XDISPLAY_WS_GRACE; "0" disables.
	defaultXDisplayWSGrace = time.Minute
	envXDisplayWSGrace     = "KOS_XDISPLAY_WS_GRACE"
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
	// wsGen counts the streams the token ever opened (incremented on each
	// websocket upgrade). The idle-grace release compares generations at
	// fire time: only the newest-stream close may trigger the teardown.
	wsGen uint64
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
		xSessionTeardown(ctx, s.exec, session, s.xserver)
		// collectExpired already purged the maps; release() still runs as
		// the single source of truth for freeing (it is a no-op here).
		s.release(session.display)
	}
}

// xTeardownExec is the exec seam the session teardown paths run their
// cluster execs through (DELETE handler, TTL sweeper, idle-grace release).
type xTeardownExec = func(
	ctx context.Context, namespace, pod, container string, command []string, stdin []byte,
) (string, error)

// xSessionTeardown runs the per-session cleanup execs: kill the recorded
// process-group leader in the app pod, drop the per-display cookie file,
// remove the xauth entries on the xserver pod. Every step is best effort —
// the display allocation is freed by the caller before this runs and stays
// the source of truth; a pod that is already gone only costs log lines.
func xSessionTeardown(ctx context.Context, exec xTeardownExec, s xDisplaySession, coord xserverCoord) {
	if s.pid != "" {
		if _, err := exec(ctx, s.namespace, s.pod, s.container, xKillArgs(s.pid), nil); err != nil {
			log.Printf("xdisplay: killing pid %s in %s/%s failed: %v", s.pid, s.namespace, s.pod, err)
		}
	}
	if _, err := exec(ctx, s.namespace, s.pod, s.container,
		[]string{"/bin/sh", "-c", "rm -f " + shellSingleQuote(xauthPath(s.display))}, nil); err != nil {
		log.Printf("xdisplay: cookie cleanup in %s/%s failed: %v", s.namespace, s.pod, err)
	}
	if _, err := exec(ctx, coord.namespace, coord.pod, "", xAuthRemoveArgs(s.display), nil); err != nil {
		log.Printf("xdisplay: xauth remove for display :%d failed: %v", s.display, err)
	}
}

// xIdleGraceRelease is the leaked-allocation safety net: the websocket leg's
// browser can vanish without the DELETE racing in (killed tab, dev reload,
// idle-close). If, after grace, no newer stream has touched the token
// (wsGen comparison), the display is freed and the app torn down. The ctx
// only decides whether server shutdown can still cancel the wait.
func xIdleGraceRelease(ctx context.Context, exec xTeardownExec, alloc *xDisplayAllocator,
	coord xserverCoord, token string, gen uint64, grace time.Duration,
) {
	if grace <= 0 {
		return
	}
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
	}
	session, ok := alloc.releaseIfIdle(token, gen)
	if !ok {
		return
	}
	log.Printf("xdisplay: idle-grace release for display :%d after stream close", session.display)
	tctx, cancel := context.WithTimeout(ctx, xdisplaySweepTimeout)
	defer cancel()
	xSessionTeardown(tctx, exec, session, coord)
}

// xdisplayWSIdleGrace reads KOS_XDISPLAY_WS_GRACE; "0" disables the net,
// anything else parseable overrides the default.
func xdisplayWSIdleGrace() time.Duration {
	if raw := os.Getenv(envXDisplayWSGrace); raw != "" {
		if d, err := time.ParseDuration(raw); err == nil && d >= 0 {
			return d
		}
	}
	return defaultXDisplayWSGrace
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

// touchWSGen bumps (and returns) the session's websocket generation: one
// increment per opened stream, handled at upgrade time. The idle-grace
// release compares generations at fire time — a newer generation means a
// stream re-opened (reconnect after refresh) and the allocation must stay.
func (x *xDisplayAllocator) touchWSGen(display int) uint64 {
	x.mu.Lock()
	defer x.mu.Unlock()
	s, ok := x.sessions[display]
	if !ok {
		return 0
	}
	s.wsGen++
	return s.wsGen
}

// releaseIfIdle frees the session — exactly once, atomically — when the
// stream identified by gen is still the newest the token ever opened
// (nothing re-connected during the grace window). TTL expiry, a DELETE
// racing first, or a reconnect all leave the maps untouched (ok=false);
// otherwise the maps are freed here and the caller runs the teardown
// execs on the returned snapshot.
func (x *xDisplayAllocator) releaseIfIdle(token string, gen uint64) (xDisplaySession, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	s, ok := x.byToken[token]
	if !ok || s.wsGen != gen {
		return xDisplaySession{}, false
	}
	out := *s
	delete(x.byToken, token)
	delete(x.sessions, out.display)
	return out, true
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
// exact string xAuthFileBytes serializes into both the X server DB record
// and the XAUTHORITY file generated inside the app pod. Random because a
// leaked cookie would grant X11 access to a whole display.
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

// xauthDBPath is the system Xauthority database file inside the X server
// pod (KOS_XAUTH_DB for deployments that mount it elsewhere).
func xauthDBPath() string {
	return envOrDefault("KOS_XAUTH_DB", "/kos/.Xauthority")
}

// xAuthAppendScript builds the sh one-liner exec-ed into the X server pod
// to APPEND one serialized Xauthority record to the DB file: the record
// arrives base64-encoded on exec stdin (never argv) and is decoded onto
// the file. `xauth` itself is not needed — the raw bytes are appended —
// and an append failure exits 3 so the caller can log/answer 500.
func xAuthAppendScript() string {
	return fmt.Sprintf(`read -r COOKIE || exit 3
printf %%s "$COOKIE" | base64 -d >> %[1]s || exit 3`, xauthDBPath())
}

// xAuthRemoveArgs unregisters the session's cookie entries on release
// (best effort). It must target ONLY the FamilyWild row appended at create
// time (`#ffff#:N`): a bare `xauth -f db remove ":N"` display spec also
// strips the entrypoint's persistent family-local record
// (kos-xserver-N/unix:N) that in-pod clients (openbox, x11vnc) need to
// authenticate against the running Xvfb, so one session teardown would
// wedge every later local client on that display.
func xAuthRemoveArgs(display int) []string {
	script := fmt.Sprintf(
		`xauth -f %[1]s -q remove "#ffff#:%[2]d" 2>/dev/null; true`,
		xauthDBPath(), display)
	return []string{"/bin/sh", "-c", script}
}

// xLaunchScript builds the shell program exec-ed into the app pod:
//  1. read the base64 blob piped through the exec stdin (the record is a
//     secret and must not linger in argv/ps output; the read doubles as a
//     TEMP diagnostic — on EOF it echoes the read's exit status and the
//     received length to stderr so a malformed exec transport is visible
//     in the pod logs — and still exits 97 on an empty cookie);
//  2. decode it straight into the Xauthority file: the blob is already a
//     serialized binary MIT-COOKIE-1 record (see xAuthFileBytes) built
//     with FamilyWild, so the app pod needs NO `xauth` binary (stock
//     containers usually lack one — "xauth: not found" killed the launch);
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
	return fmt.Sprintf(`read -r COOKIE || { echo "xlaunch: read-empty rc=$? len=$(printf %%s "$COOKIE" | wc -c)" >&2; [ -n "$COOKIE" ] || exit 97; }
printf %%s "$COOKIE" | base64 -d > %[3]s || exit 98
setsid env DISPLAY=%[2]s:%[1]d XAUTHORITY=%[3]s %[4]s </dev/null >/dev/null 2>&1 & echo $!
exit 0`,
		display, host, xauthPath, strings.Join(quoted, " "))
}

// xAuthFileBytes serializes ONE binary MIT-COOKIE-1 Xauthority record for
// the given lowercase-hex cookie and display number, with the full record
// layout: family FamilyWild (0xFFFF) with an empty address, the length-
// prefixed DISPLAY NUMBER string, the magic name and the decoded cookie
// bytes — every length field a big-endian uint16. FamilyWild makes the
// record match for ANY display/connection (the standard x11docker-style
// trick), so the same record works both client-side inside the app pod
// (no `xauth` binary needed) and server-side in the X server's DB.
func xAuthFileBytes(cookieHex string, display int) ([]byte, error) {
	decoded, err := hex.DecodeString(cookieHex)
	if err != nil {
		return nil, fmt.Errorf("cookie is not valid hex: %w", err)
	}
	numStr := strconv.Itoa(display)
	name := []byte("MIT-MAGIC-COOKIE-1")
	buf := make([]byte, 0, 10+len(numStr)+len(name)+len(decoded))
	buf = binary.BigEndian.AppendUint16(buf, 0xFFFF) // FamilyWild
	buf = binary.BigEndian.AppendUint16(buf, 0)      // empty address
	buf = binary.BigEndian.AppendUint16(buf, uint16(len(numStr)))
	buf = append(buf, numStr...)
	buf = binary.BigEndian.AppendUint16(buf, uint16(len(name)))
	buf = append(buf, name...)
	buf = binary.BigEndian.AppendUint16(buf, uint16(len(decoded)))
	return append(buf, decoded...), nil
}

// xLaunchStdin builds the launch exec's exact stdin: the already-serialized
// base64-encoded Xauthority record (secret — never argv) followed by a
// terminating newline so `read -r` at EOF succeeds. The launch script
// additionally tolerates the missing newline for transports that trim it.
func xLaunchStdin(record []byte) []byte {
	return b64Stdin(record)
}

// xAuthAppendStdin builds the xauth-append exec's stdin, sharing the
// base64-encoding contract with xLaunchStdin (secret on stdin, one
// terminating newline so `read`/decode succeeds).
func xAuthAppendStdin(record []byte) []byte {
	return b64Stdin(record)
}

// b64Stdin encodes a secret payload for exec stdin: base64 body plus one
// terminating newline, the contract the server-side decode script and the
// launch script both rely on.
func b64Stdin(b []byte) []byte {
	return []byte(base64.StdEncoding.EncodeToString(b) + "\n")
}

// xExec runs an exec through the api's exec seam: the real execRun unless
// a test injected an execer (mirrors the xdialer seam for the websocket
// leg). Used by the create handler so its success path is unit-testable
// without a cluster.
func (a *api) xExec(ctx context.Context, namespace, pod, container string, command []string, stdin []byte) (string, error) {
	if a.execer != nil {
		return a.execer(ctx, namespace, pod, container, command, stdin)
	}
	return execRun(ctx, a.restConfig, namespace, pod, container, command, stdin)
}

// teardownExec returns the exec seam for the teardown paths (DELETE,
// idle-grace release): the injected test execer when present, otherwise
// the real execRun against restConfig.
func (a *api) teardownExec() xTeardownExec {
	if a.execer != nil {
		return a.execer
	}
	cfg := a.restConfig
	return func(ctx context.Context, namespace, pod, container string, command []string, stdin []byte) (string, error) {
		return execRun(ctx, cfg, namespace, pod, container, command, stdin)
	}
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

	// 1) Build the record once (also used for the app pod's client-side
	// file) and APPEND it to the X server's system Xauthority: a
	// FamilyWild row, because the server side rejects records whose
	// address cannot match the connecting client pod IP.
	cookie, err := newXDisplayCookie()
	if err != nil {
		log.Printf("xdisplay: cookie generation failed: %v", err)
		writeError(w, err)
		return
	}
	record, rerr := xAuthFileBytes(cookie, display)
	if rerr != nil {
		log.Printf("xdisplay: bad cookie: %v", rerr)
		writeError(w, rerr)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if _, err := a.xExec(ctx, coord.namespace, coord.pod, "",
		[]string{"/bin/sh", "-c", xAuthAppendScript()}, xAuthAppendStdin(record)); err != nil {
		log.Printf("xdisplay: xauth append on %s/%s failed: %v", coord.namespace, coord.pod, err)
		writeError(w, err)
		return
	}

	// 2) Launch the command in the app pod; the serialized Xauthority
	// record travels base64 on exec stdin (newline-terminated, see
	// xLaunchStdin) so it never shows in argv. stdout's single line is the
	// setsid leader PID. The wrapper backgrounds the GUI and exits 0, so
	// this exec returns promptly.
	script := xLaunchScript(coord.displayHost(), display, xauthPath(display), req.Command)
	stdin := xLaunchStdin(record)
	log.Printf("xdisplay: launch stdin bytes=%d display=%d", len(record), display)
	out, err := a.xExec(ctx, req.Namespace, req.Pod, req.Container,
		[]string{"/bin/sh", "-c", script}, stdin)
	if err != nil {
		log.Printf("xdisplay: launch in %s/%s failed: %v (pod said: %s)",
			req.Namespace, req.Pod, err, strings.TrimSpace(out))
		writeError(w, err)
		return
	}
	pid, err := parsePID(out)
	if err != nil {
		log.Printf("xdisplay: launch in %s/%s produced no PID: %v", req.Namespace, req.Pod, err)
		writeError(w, err)
		return
	}

	// 3) Record the session and answer. The session stays allocated for the
	// whole TTL/DELETE lifecycle, so the deferred failure-cleanup release
	// must not run past this point.
	released = true
	a.xdisplay.record(display, token, req, pid)

	// Never-streamed allocation guard: a POST whose websocket never opens
	// (browser died between the two calls) would otherwise hold a display
	// until the TTL sweep. Generation 0 = no stream has touched the token
	// yet; any open stream bumps it and cancels this teardown.
	if grace := xdisplayWSIdleGrace(); grace > 0 {
		go xIdleGraceRelease(context.WithoutCancel(ctx), a.teardownExec(),
			a.xdisplay, newXServerCoord(), token, 0, grace)
	}

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

	// Best-effort teardown (kill + cookie cleanup + xauth remove): the
	// display is freed afterwards regardless, so a pod that is already
	// gone only costs log lines and never leaks the allocation.
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	xSessionTeardown(ctx, a.teardownExec(), *session, newXServerCoord())

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
// (direct dialer mode) the RFB port for the pool's first display must accept
// a TCP dial — unreachable without a pod-IP route, so port-forward mode
// (kos-server outside the cluster) reports availability from the pod get
// alone; the portforward dial itself validates the pod when a session
// opens. Only the cheap pod get is done when the pod is missing — no point
// dialing.
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

	if xdisplayDialerMode() == xDialerPortFw {
		// No pod-IP route: the TCP probe would always fail and lie about
		// an apiserver-reachable x11vnc port. Pod scheduled with an IP is
		// the best the health endpoint can honestly answer.
		writeJSON(w, http.StatusOK, xDisplayHealthResponse{Source: a.source, Available: true})
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

// port-forward requestID sequence for stream headers.
var xForwardRequestID atomic.Uint64

// xDisplayDialerMode selects how the RFB websocket proxy reaches x11vnc.
type xDisplayDialerMode string

const (
	// xDialerPortFw tunnels the TCP stream through the API server
	// port-forward subresource (KEP-4006 SPDY-over-websocket, falling back
	// to plain SPDY upgrade on older clusters). Works wherever the
	// apiserver is reachable — the only mode when kos-server runs outside
	// the cluster.
	xDialerPortFw xDisplayDialerMode = "portfw"
	// xDialerDirect dials podIP:5900+N directly; cheaper, but only works
	// for in-cluster kos-server deployments (or any host with a pod-IP
	// route).
	xDialerDirect xDisplayDialerMode = "direct"
)

// xdisplayDialerMode resolves KOS_XDISPLAY_DIALER: "direct" selects the
// legacy direct dial, every non-empty other value (or empty, the default)
// selects port-forward.
func xdisplayDialerMode() xDisplayDialerMode {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(envXDisplayDialer))) {
	case string(xDialerDirect):
		return xDialerDirect
	default:
		return xDialerPortFw
	}
}

// xPortForwardRequestURL builds the URL for a pod portforward subresource
// request, mirroring execRequestURL's String()-building style so it works
// with any rest.Config (including test fakes with no REST client).
func xPortForwardRequestURL(cfg *rest.Config, namespace, pod string, port int) (string, error) {
	// Same defense in depth as execRequestURL: the names are interpolated
	// into the API path, so they must be well-formed even though handlers
	// validate them earlier.
	if !isK8sName(namespace) {
		return "", fmt.Errorf("invalid namespace %q", namespace)
	}
	if !isK8sName(pod) {
		return "", fmt.Errorf("invalid pod %q", pod)
	}
	if port <= 0 || port > 65535 {
		return "", fmt.Errorf("invalid port %d", port)
	}

	base := strings.TrimSuffix(cfg.Host, "/")
	params := urlpkg.Values{}
	params.Set("ports", strconv.Itoa(port))

	return fmt.Sprintf("%s/api/v1/namespaces/%s/pods/%s/portforward?%s",
		base, namespace, pod, params.Encode()), nil
}

// xSPDYDialer builds the classic SPDY port-forward dialer
// (k8s.io/client-go/transport/spdy), reusing the rest.Config's TLS and auth
// transportation via spdy.RoundTripperFor. Kept as the fallback for clusters
// without the KEP-4006 websocket-tunneling endpoint (< v1.30-ish).
func xSPDYDialer(cfg *rest.Config, parsed *urlpkg.URL) (httpstream.Dialer, error) {
	transport, upgrader, err := spdy.RoundTripperFor(cfg)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Transport: transport, Timeout: xdisplayPortFwDialTimeout}
	return spdy.NewDialer(upgrader, client, http.MethodGet, parsed), nil
}

// xPodDialer opens a raw TCP stream to the pod's VNC port through the K8s
// API server port-forward subresource and exposes it as a net.Conn for
// proxyRFB. Unlike kubectl (and the package's own PortForwarder), no local
// listener is bound: the forwarding is userland-only — the data stream
// created directly on the upgraded httpstream connection is handed back, so
// kos-server never collides with host ports 5921-5925 and saves a localhost
// hop. The whole dial (upgrade + stream setup) is bounded by
// xdisplayPortFwDialTimeout; closing the returned net.Conn tears down the
// entire port-forward connection so abrupt close propagates to the proxy
// loops.
func xPodDialer(ctx context.Context, cfg *rest.Config, namespace, pod string, port int) (net.Conn, error) {
	if cfg == nil {
		return nil, errOffline
	}

	rawURL, err := xPortForwardRequestURL(cfg, namespace, pod, port)
	if err != nil {
		return nil, err
	}
	parsed, err := urlpkg.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("port-forward url %q: %w", rawURL, err)
	}

	// Preferred: SPDY-over-websocket tunneling (KEP-4006 PortForwardWebsockets),
	// what v1.37 speaks; it reuses rest.Config's TLS/auth through its own
	// websocket.RoundTripperFor. Fallback: plain SPDY upgrade for older
	// clusters. Any primary dial error falls through to the secondary.
	primary, err := portforward.NewSPDYOverWebsocketDialer(parsed, cfg)
	if err != nil {
		return nil, fmt.Errorf("build websocket port-forward dialer: %w", err)
	}
	secondary, err := xSPDYDialer(cfg, parsed)
	if err != nil {
		return nil, fmt.Errorf("build SPDY port-forward dialer: %w", err)
	}
	dialer := portforward.NewFallbackDialer(primary, secondary, func(error) bool { return true })

	// The effective budget: xdisplayPortFwDialTimeout, tightened to the
	// caller's deadline when it is sooner (the error must not claim a
	// budget the caller shortened).
	budget := xdisplayPortFwDialTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); 0 < remaining && remaining < budget {
			budget = remaining
		}
	}
	dialCtx, cancelDial := context.WithTimeout(ctx, budget)
	defer cancelDial()

	type dialResult struct {
		conn     httpstream.Connection
		protocol string
		err      error
	}
	results := make(chan dialResult, 1)
	go func() {
		conn, protocol, err := dialer.Dial(portforward.PortForwardProtocolV1Name)
		results <- dialResult{conn: conn, protocol: protocol, err: err}
	}()

	// Priority to an already-expired deadline: the dialer goroutine cannot
	// produce a result before a hanging upgrade is canceled, so once the
	// budget is spent the timeout error is the outcome.
	select {
	case <-dialCtx.Done():
		return xPortForwardTimeoutError(namespace, pod, port, budget)
	default:
	}
	select {
	case res := <-results:
		if res.err != nil {
			return nil, fmt.Errorf("port-forward %s/%s port %d: %w", namespace, pod, port, res.err)
		}
		if res.protocol != portforward.PortForwardProtocolV1Name {
			_ = res.conn.Close()
			return nil, fmt.Errorf("port-forward %s/%s port %d: negotiated %q, want %q",
				namespace, pod, port, res.protocol, portforward.PortForwardProtocolV1Name)
		}
		return xForwardedConn(res.conn, port)
	case <-dialCtx.Done():
		// The buffered channel lets the dialer goroutine finish without
		// leaking once the canceled round trip unwinds.
		return xPortForwardTimeoutError(namespace, pod, port, budget)
	}
}

// xPortForwardTimeoutError is the bounded-dial failure: descriptive about
// which leg hung (upgrade through the apiserver), not a bare timeout.
func xPortForwardTimeoutError(namespace, pod string, port int, budget time.Duration) (net.Conn, error) {
	return nil, fmt.Errorf("port-forward %s/%s port %d not ready after %s: "+
		"apiserver unreachable or pod not ready", namespace, pod, port, budget)
}

// xForwardedConn creates the port-forward stream pair on an upgraded
// connection (the same headers PortForwarder.handleConnection writes) and
// returns the data stream as a net.Conn. A goroutine drains the error
// stream: apiserver-reported forwarding errors are logged and immediately
// propagate as a connection teardown, ending the RFB proxy loops.
func xForwardedConn(conn httpstream.Connection, port int) (net.Conn, error) {
	portStr := strconv.Itoa(port)
	requestID := strconv.FormatUint(xForwardRequestID.Add(1), 10)

	headers := http.Header{}
	headers.Set(corev1.StreamType, corev1.StreamTypeError)
	headers.Set(corev1.PortHeader, portStr)
	headers.Set(corev1.PortForwardRequestIDHeader, requestID)
	errorStream, err := conn.CreateStream(headers)
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("port-forward error stream (port %d): %w", port, err)
	}

	headers.Set(corev1.StreamType, corev1.StreamTypeData)
	dataStream, err := conn.CreateStream(headers)
	if err != nil {
		_ = errorStream.Reset()
		_ = conn.Close()
		return nil, fmt.Errorf("port-forward data stream (port %d): %w", port, err)
	}

	go func() {
		// Read incrementally (not io.ReadAll): the stream does not EOF
		// until the whole connection closes, and a first error chunk must
		// propagate immediately — the data leg dies with it, unwinding
		// proxyRFB. Plain EOF/error exits the loop (either the other
		// goroutines already unwound, or cleanup Close fires anyway).
		buf := make([]byte, 512)
		for {
			n, readErr := errorStream.Read(buf)
			if n > 0 {
				log.Printf("xdisplay: port-forward error from apiserver (port %d): %s",
					port, strings.TrimSpace(string(buf[:n])))
				_ = conn.Close()
				return
			}
			if readErr != nil {
				return
			}
		}
	}()

	return &xForwardedNetConn{Stream: dataStream, connection: conn}, nil
}

// xForwardedNetConn adapts the port-forward data stream into net.Conn for
// proxyRFB. Destinations/addresses are synthetic (the network hop is the
// apiserver tunnel) and deadlines are accepted without effect: stream
// liveness is enforced by the apiserver keepalive and the browser-side read
// deadline — on either side ending, Close() tears down everything.
type xForwardedNetConn struct {
	httpstream.Stream
	connection httpstream.Connection
	closeConn  sync.Once
}

func (c *xForwardedNetConn) Close() error {
	err := c.Stream.Close()
	c.closeConn.Do(func() { _ = c.connection.Close() })
	return err
}

func (c *xForwardedNetConn) LocalAddr() net.Addr              { return xForwardedAddr{} }
func (c *xForwardedNetConn) RemoteAddr() net.Addr             { return xForwardedAddr{} }
func (c *xForwardedNetConn) SetDeadline(time.Time) error      { return nil }
func (c *xForwardedNetConn) SetReadDeadline(time.Time) error  { return nil }
func (c *xForwardedNetConn) SetWriteDeadline(time.Time) error { return nil }

// xForwardedAddr is the synthetic net.Addr of a port-forwarded stream.
type xForwardedAddr struct{}

func (xForwardedAddr) Network() string { return "portforward" }
func (xForwardedAddr) String() string  { return "pod/portforward" }

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
// session display's x11vnc TCP listener (websockify pattern). The cluster
// leg depends on KOS_XDISPLAY_DIALER: "portfw" (default) tunnels the TCP
// stream through the API server port-forward subresource (xPodDialer), so
// kos-server works outside the cluster too; "direct" dials podIP:5900+N.
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

	// Idle-grace safety net: whatever ends this request (upgrade failure,
	// dial failure, proxy end, browser disconnect, stream idle close)
	// schedules a teardown that fires after the grace window unless a
	// newer stream re-opened the token in the meantime (wsGen guard).
	// Without it a vanished browser holds its display until the TTL sweep.
	wsGen := a.xdisplay.touchWSGen(session.display)
	if grace := xdisplayWSIdleGrace(); grace > 0 {
		defer func() {
			go xIdleGraceRelease(context.WithoutCancel(r.Context()), a.teardownExec(),
				a.xdisplay, newXServerCoord(), token, wsGen, grace)
		}()
	}

	// Everything the request must learn through HTTP JSON happens BEFORE
	// the upgrade — status codes die with the handshake. Only direct mode
	// needs the pod get (it hoists a missing/unready xserver pod into an
	// ordinary error response); the port-forward dial validates the pod
	// itself at the apiserver and reports failures post-upgrade.
	var podIP string
	if xdisplayDialerMode() == xDialerDirect {
		coord := newXServerCoord()
		podGetCtx, cancelPodGet := context.WithTimeout(r.Context(), 10*time.Second)
		pod, err := a.clientset.CoreV1().Pods(coord.namespace).Get(podGetCtx, coord.pod, metav1.GetOptions{})
		cancelPodGet()
		if err != nil {
			writeError(w, err)
			return
		}
		podIP = pod.Status.PodIP
	}

	// Upgrade AFTER authorization and the cheap pod checks.
	conn, err := wsUpgrader().Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already wrote the failure response.
	}
	defer conn.Close()

	if xdisplayDialerMode() == xDialerDirect {
		if podIP == "" {
			closeWSWithReason(conn, websocket.CloseTryAgainLater, "xserver pod has no IP")
			return
		}
		addr := net.JoinHostPort(podIP, strconv.Itoa(session.vncPort))
		upstream, err := net.DialTimeout("tcp", addr, xdisplayDialTimeout)
		if err != nil {
			closeWSWithReason(conn, websocket.CloseTryAgainLater, "dial x11vnc: "+err.Error())
			return
		}
		defer upstream.Close()
		proxyRFB(conn, upstream, idleTimeout())
		return
	}

	// Port-forward mode: bound the tunnel dial but keep it off the 15s
	// request budget (the websocket is hijacked and long-lived; exec/ws
	// derives its cluster leg the same way via context.WithoutCancel). The
	// forwarding targets the X SERVER pod — x11vnc listens on its 5900+display
	// port; the session's namespace/pod name the APP pod the GUI runs in.
	coord := newXServerCoord()
	dialCtx, cancelDial := context.WithTimeout(context.WithoutCancel(r.Context()), xdisplayPortFwDialTimeout)
	defer cancelDial()

	upstream, err := a.xDial(dialCtx, coord.namespace, coord.pod, session.vncPort)
	if err != nil {
		closeWSWithReason(conn, websocket.CloseTryAgainLater, "port-forward to x11vnc: "+err.Error())
		return
	}
	defer upstream.Close()
	log.Printf("xdisplay: websocket session for display :%d via apiserver port-forward %s/%s port %d",
		session.display, coord.namespace, coord.pod, session.vncPort)
	proxyRFB(conn, upstream, idleTimeout())
}

// xDial resolves the RFB upstream for a session through the configured
// cluster-transport dialer; a.xdialer overrides it (test seam, injected as
// a fake dialer function).
func (a *api) xDial(ctx context.Context, namespace, pod string, port int) (net.Conn, error) {
	if a.xdialer != nil {
		return a.xdialer(ctx, namespace, pod, port)
	}
	return xPodDialer(ctx, a.restConfig, namespace, pod, port)
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
