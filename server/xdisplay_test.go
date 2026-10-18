package main

import (
	"context"
	"encoding/base64"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
)

// serveXDisplay runs a request through the xdisplay routes. It mirrors the
// serve() helper of main_test.go but allows request bodies (POST) and gives
// every call a fresh pool unless the test builds one itself.
func serveXDisplay(t *testing.T, a *api, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	if a == nil {
		a = &api{}
	}
	mux := newMux(a)
	rec := httptest.NewRecorder()
	var rdr *strings.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	} else {
		rdr = strings.NewReader("")
	}
	req := httptest.NewRequest(method, target, rdr)
	mux.ServeHTTP(rec, req)
	return rec
}

// testAllocator builds a 2-display pool (:21, :22) for fast tests.
func testAllocator(t *testing.T) *xDisplayAllocator {
	t.Helper()
	t.Setenv("KOS_XDISPLAY_START", "21")
	t.Setenv("KOS_XDISPLAY_POOL", "2")
	return newXDisplayAllocator()
}

// fakeXServerClient provides a fake clientset holding the xserver pod on
// 127.0.0.1 so TC5 vncPort dials land on loopback listeners.
func fakeXServerClient(t *testing.T, ip string) *fake.Clientset {
	t.Helper()
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: correspondingXServerPod("kos-xserver-0"), Namespace: correspondingXServerNamespace("kos")},
		Status:     corev1.PodStatus{PodIP: ip},
	}
	return fake.NewSimpleClientset(pod)
}

// correspondingXServerPod / correspondingXServerNamespace keep the fake
// fixture in sync with the env-based defaults instead of hard-coding them
// twice.
func correspondingXServerPod(pod string) string      { return pod }
func correspondingXServerNamespace(ns string) string { return ns }

func testAPI(t *testing.T, alloc *xDisplayAllocator) *api {
	t.Helper()
	return &api{
		client:     &stubClient{},
		source:     liveSource,
		clientset:  fakeXServerClient(t, "10.0.0.5"),
		restConfig: &rest.Config{Host: "http://127.0.0.1:1"},
		xdisplay:   alloc,
	}
}

func TestXDisplayAllocatorAllocateFreeIdempotency(t *testing.T) {
	alloc := testAllocator(t)

	d1, tok1, err := alloc.allocate()
	if err != nil || d1 != 21 {
		t.Fatalf("first allocate = %d, %v; want 21, nil", d1, err)
	}
	if len(tok1) != 32 {
		t.Fatalf("token = %q, want 32 hex chars", tok1)
	}

	d2, _, err := alloc.allocate()
	if err != nil || d2 != 22 {
		t.Fatalf("second allocate = %d, %v; want 22, nil", d2, err)
	}

	// Pool exhausted at count 2.
	if _, _, err := alloc.allocate(); err == nil {
		t.Fatal("third allocate succeeded on an exhausted pool")
	}

	// Releasing frees the lowest slot again, proving the registry, not a
	// counter, tracks availability.
	alloc.release(d1)
	d3, tok3, err := alloc.allocate()
	if err != nil || d3 != 21 {
		t.Fatalf("realloc after release = %d, %v; want 21, nil", d3, err)
	}
	if tok3 == tok1 {
		t.Fatal("realloc reused the old token — a released token must die")
	}

	// Double release is a no-op (DELETE retry semantics).
	alloc.release(d1)
	alloc.release(d1)
	if _, ok := alloc.lookupByDisplay(d1); ok {
		t.Fatal("display still busy after release")
	}
	if len(alloc.list(time.Now())) != 1 {
		t.Fatalf("list = %+v, want exactly the :22 session", alloc.list(time.Now()))
	}
}

func TestXDisplayAllocatorExpiry(t *testing.T) {
	testAllocator(t)
	alloc := newXDisplayAllocator()

	display, token, err := alloc.allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	s, ok := alloc.lookup(token)
	if !ok || s.display != display {
		t.Fatalf("lookup = %v, %v", s, ok)
	}

	// Force expiry and verify every consumer treats the session as gone.
	alloc.mu.Lock()
	if s := alloc.sessions[display]; s != nil {
		s.expiresAt = time.Now().Add(-time.Minute)
	}
	alloc.mu.Unlock()

	if _, ok := alloc.lookup(token); ok {
		t.Fatal("lookup accepted an expired token")
	}
	if _, ok := alloc.lookupByDisplay(display); ok {
		t.Fatal("lookupByDisplay accepted an expired session")
	}
	for _, s := range alloc.list(time.Now()) {
		if s.display == display {
			t.Fatal("list still reports an expired session")
		}
	}
}

func TestXDisplayAllocatorRecord(t *testing.T) {
	alloc := newXDisplayAllocator()
	display, token, err := alloc.allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}

	alloc.record(display, token, xDisplayRequest{
		Namespace: "default", Pod: "firefox-0", Container: "app", App: "firefox",
		Command: []string{"firefox"},
	}, "1234")
	if s, ok := alloc.lookup(token); !ok {
		t.Fatal("record lost the session")
	} else {
		if s.pid != "1234" || s.app != "firefox" || s.pod != "firefox-0" || s.namespace != "default" || s.container != "app" {
			t.Errorf("session = %+v", s)
		}
		if s.vncPort != 5900+display {
			t.Errorf("vncPort = %d, want %d", s.vncPort, 5900+display)
		}
	}

	// Recording against a mismatched token (released and re-allocated
	// underneath) must never poison the newer session.
	alloc.release(display)
	d2, tok2, _ := alloc.allocate()
	alloc.record(display, token, xDisplayRequest{Namespace: "evil", Pod: "evil", Command: []string{"x"}}, "9")
	if _, ok := alloc.lookup(tok2); !ok {
		t.Fatal("record corrupted the new session")
	}
	if s, _ := alloc.lookup(tok2); s.namespace == "evil" {
		t.Errorf("record with stale token touched session %+v", s)
	}
	_ = d2
}

func TestNewXDisplayCookieAndToken(t *testing.T) {
	c1, err := newXDisplayCookie()
	if err != nil {
		t.Fatalf("cookie: %v", err)
	}
	if len(c1) != 2*xdisplayCookieBytes {
		t.Fatalf("cookie = %q, want %d hex chars", c1, 2*xdisplayCookieBytes)
	}
	c2, _ := newXDisplayCookie()
	if c1 == c2 {
		t.Fatal("two cookies are identical — randomness broken")
	}

	tk1, _ := newXDisplayToken()
	tk2, _ := newXDisplayToken()
	if tk1 == tk2 {
		t.Fatal("two tokens are identical — randomness broken")
	}
}

func TestNewXServerCoordEnvOverrides(t *testing.T) {
	t.Run("defaults", func(t *testing.T) {
		c := newXServerCoord()
		if c.namespace != "kos" || c.pod != "kos-xserver-0" || c.service != "kos-xserver" {
			t.Fatalf("coord = %+v", c)
		}
		if host := c.displayHost(); host != "kos-xserver.kos.svc" {
			t.Fatalf("displayHost = %q, want kos-xserver.kos.svc", host)
		}
	})

	t.Run("overrides", func(t *testing.T) {
		t.Setenv("KOS_XSERVER_NAMESPACE", "gfx")
		t.Setenv("KOS_XSERVER_POD", "xs-1")
		t.Setenv("KOS_XSERVER_SERVICE", "graph")
		c := newXServerCoord()
		if c.pod != "xs-1" || c.service != "graph" || c.namespace != "gfx" {
			t.Fatalf("coord = %+v", c)
		}
		if host := c.displayHost(); host != "graph.gfx.svc" {
			t.Fatalf("displayHost = %q, want graph.gfx.svc", host)
		}
	})
}

func TestXDisplayAllocatorEnvConfig(t *testing.T) {
	t.Run("defaults", func(t *testing.T) {
		t.Setenv("KOS_XDISPLAY_START", "")
		t.Setenv("KOS_XDISPLAY_POOL", "")
		alloc := newXDisplayAllocator()
		if alloc.start != defaultXDisplayStart || alloc.count != defaultXDisplayPool {
			t.Fatalf("start/count = %d/%d", alloc.start, alloc.count)
		}
	})

	t.Run("custom pool", func(t *testing.T) {
		t.Setenv("KOS_XDISPLAY_START", "30")
		t.Setenv("KOS_XDISPLAY_POOL", "3")
		alloc := newXDisplayAllocator()
		if alloc.start != 30 || alloc.count != 3 {
			t.Fatalf("start/count = %d/%d", alloc.start, alloc.count)
		}
		d1, _, err := alloc.allocate()
		if err != nil || d1 != 30 {
			t.Fatalf("first display = %d, %v; want 30", d1, err)
		}
	})
}

func TestXAuthArgs(t *testing.T) {
	cookie := "abcdef0123456789abcdef0123456789"

	add := xAuthAddArgs(21, "kos-xserver.kos.svc", cookie)
	if len(add) != 3 || add[0] != "/bin/sh" {
		t.Fatalf("xAuthAddArgs = %+v", add)
	}
	if !strings.Contains(add[2], `xauth add ":21" MIT-COOKIE-1 `+cookie) {
		t.Errorf("add script missing local entry: %s", add[2])
	}
	if !strings.Contains(add[2], `xauth add "kos-xserver.kos.svc:21" MIT-COOKIE-1 `+cookie) {
		t.Errorf("add script missing FQDN entry: %s", add[2])
	}

	rm := xAuthRemoveArgs(21, "kos-xserver.kos.svc")
	if !strings.Contains(rm[2], `xauth remove ":21"`) {
		t.Errorf("remove script = %s", rm[2])
	}

	kill := xKillArgs("1207")
	if !strings.Contains(kill[2], "kill -TERM -1207") || !strings.Contains(kill[2], "kill -KILL -1207") {
		t.Errorf("kill script must signal the process group: %s", kill[2])
	}
	if strings.Contains(kill[2], "sleep 1") {
		t.Errorf("kill script must not hardcode a 1s sleep: %s", kill[2])
	}
}

func TestShellSingleQuote(t *testing.T) {
	cases := []struct{ arg, want string }{
		{"firefox", "'firefox'"},
		{"it's me", "'it'\\''s me'"},
	}
	for _, tc := range cases {
		if got := shellSingleQuote(tc.arg); got != tc.want {
			t.Errorf("shellSingleQuote(%q) = %q, want %q", tc.arg, got, tc.want)
		}
	}
}

func TestXLaunchScript(t *testing.T) {
	script := xLaunchScript("kos-xserver.kos.svc", 21, "/tmp/.kos-xauth-21", []string{"firefox", "--no-remote"})

	// The wrapper must tolerate a cookie line without the trailing newline
	// (some exec transports trim it) and must fail loudly otherwise.
	if !strings.Contains(script, `read -r COOKIE || [ -n "$COOKIE" ] || exit 97`) {
		t.Errorf("script must read the cookie tolerantly: %s", script)
	}
	if !strings.Contains(script, "base64 -d") {
		t.Errorf("script must decode the cookie from stdin: %s", script)
	}
	if !strings.Contains(script, `xauth -f /tmp/.kos-xauth-21 add kos-xserver.kos.svc:21 MIT-COOKIE-1`) {
		t.Errorf("script must provision XAUTHORITY via xauth: %s", script)
	}
	// The GUI is launched in the BACKGROUND under setsid and the wrapper
	// prints $! (the setsid leader PID, whose pgid equals the PID) then
	// exits immediately — execRun must return while the app keeps running.
	if !strings.Contains(script, `setsid env DISPLAY=kos-xserver.kos.svc:21 XAUTHORITY=/tmp/.kos-xauth-21 'firefox' '--no-remote' </dev/null >/dev/null 2>&1 & echo $!`) {
		t.Errorf("script must background the command under setsid and echo $!: %s", script)
	}
	if !strings.Contains(script, "exit 0") {
		t.Errorf("script must exit 0 right after backgrounding: %s", script)
	}
	if strings.Contains(script, "exec env") {
		t.Errorf("script must not exec the GUI in the wrapper's process: %s", script)
	}
	// Args with quotes stay single-quoted.
	if !strings.Contains(script, "'\\''") && !strings.Contains(script, "'firefox'") {
		t.Errorf("command not quoted: %s", script)
	}
}

// TestXLaunchStdinCookieContract pins the exact stdin bytes the launch exec
// sends: base64(cookie) plus ONE terminating newline. `read -r` at EOF only
// succeeds for newline-terminated input; both sides of this contract are
// asserted here and in the script check above.
func TestXLaunchStdinCookieContract(t *testing.T) {
	stdin := xLaunchStdin("cafebabe1234")
	want := base64.StdEncoding.EncodeToString([]byte("cafebabe1234")) + "\n"
	if string(stdin) != want {
		t.Fatalf("stdin = %q, want %q", stdin, want)
	}
}

// TestXDisplaySweeper proves the TTL sweep: expired entries are purged from
// BOTH maps (token + display), the recorded process group is killed inside
// the app pod and xauth-remove runs on the xserver pod — through a fake
// executor, no cluster involved.
func TestXDisplaySweeper(t *testing.T) {
	alloc := testAllocator(t)
	display, token, err := alloc.allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	alloc.record(display, token, xDisplayRequest{
		Namespace: "team-a", Pod: "app-1", Container: "web", Command: []string{"firefox"},
	}, "4321")
	alloc.mu.Lock()
	alloc.sessions[display].expiresAt = time.Now().Add(-time.Minute)
	alloc.mu.Unlock()

	var calls []string
	sweeper := &xdisplaySweeper{
		interval: time.Minute,
		timeout:  time.Second,
		now:      time.Now,
		collect:  alloc.collectExpired,
		exec: func(_ context.Context, namespace, pod, container string, command []string, _ []byte) (string, error) {
			calls = append(calls, strings.Join([]string{namespace, pod, container, strings.Join(command, " ")}, "|"))
			return "", nil
		},
		release: alloc.release,
		xserver: newXServerCoord(),
	}
	sweeper.sweep(context.Background())

	joined := strings.Join(calls, "\n")
	if !strings.Contains(joined, "team-a|app-1|web|/bin/sh -c kill -TERM -4321") {
		t.Errorf("sweep never killed the app process group; calls:\n%s", joined)
	}
	if !strings.Contains(joined, "kos|kos-xserver-0||/bin/sh -c xauth remove \":21\" 2>/dev/null") {
		t.Errorf("sweep never removed the xauth entry on the xserver pod; calls:\n%s", joined)
	}

	// Both maps purged and the display freed for reallocation.
	if _, ok := alloc.lookup(token); ok {
		t.Fatal("expired token survived the sweep")
	}
	if _, ok := alloc.lookupByDisplay(display); ok {
		t.Fatal("expired session survived the sweep")
	}
	if _, _, err := alloc.allocate(); err != nil {
		t.Fatalf("display not freed by the sweep: %v", err)
	}

	// One pass only issues kill + xauth remove for the one expired session.
	if len(calls) != 2 {
		t.Fatalf("exec calls = %d (%v), want 2", len(calls), calls)
	}
}

// TestXDisplaySweeperKeepsActiveSessions proves the sweep leaves valid
// sessions untouched (no kill, no release).
func TestXDisplaySweeperKeepsActiveSessions(t *testing.T) {
	alloc := testAllocator(t)
	display, token, err := alloc.allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	alloc.record(display, token, xDisplayRequest{Namespace: "ns", Pod: "p1", Command: []string{"x"}}, "99")

	var execCalls int
	sweeper := &xdisplaySweeper{
		interval: time.Minute,
		timeout:  time.Second,
		now:      time.Now,
		collect:  alloc.collectExpired,
		exec: func(context.Context, string, string, string, []string, []byte) (string, error) {
			execCalls++
			return "", nil
		},
		release: alloc.release,
		xserver: newXServerCoord(),
	}
	sweeper.sweep(context.Background())

	if execCalls != 0 {
		t.Fatalf("sweeper exec'd %d times for an active session", execCalls)
	}
	if _, ok := alloc.lookup(token); !ok {
		t.Fatal("sweeper removed an active session")
	}
	if _, ok := alloc.lookupByDisplay(display); !ok {
		t.Fatal("sweeper released an active display")
	}
}

func TestParsePID(t *testing.T) {
	pid, err := parsePID("1207\nfirefox output\n")
	if err != nil || pid != "1207" {
		t.Fatalf("parsePID = %q, %v; want 1207, nil", pid, err)
	}
	if _, err := parsePID("no pid here"); err == nil {
		t.Fatal("parsePID accepted garbage")
	}
	if _, err := parsePID(""); err == nil {
		t.Fatal("parsePID accepted empty output")
	}
}

func TestXauthPathAndAgeOf(t *testing.T) {
	if got := xauthPath(21); got != "/tmp/.kos-xauth-21" {
		t.Fatalf("xauthPath = %q", got)
	}
	if ageOf(time.Now()) < 0 {
		t.Fatal("ageOf must never be negative")
	}
}

func TestHandleXDisplayCreateValidation(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"invalid JSON", "{", "invalid JSON body"},
		{"missing namespace", `{"pod":"p1","command":["x"]}`, "missing required field: namespace"},
		{"missing pod", `{"namespace":"ns","command":["x"]}`, "missing required field: pod"},
		{"missing command", `{"namespace":"ns","pod":"p1"}`, "missing required field: command"},
		{"empty command", `{"namespace":"ns","pod":"p1","command":[]}`, "missing required field: command"},
		{"invalid namespace", `{"namespace":"../etc","pod":"p1","command":["x"]}`, "invalid namespace"},
		{"invalid pod", `{"namespace":"ns","pod":"p p","command":["x"]}`, "invalid pod"},
		{"invalid container", `{"namespace":"ns","pod":"p1","container":"c1;c2","command":["x"]}`, "invalid container"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := serveXDisplay(t, &api{}, http.MethodPost, "/api/xdisplay", tc.body)
			assertStatus(t, rec, http.StatusBadRequest)
			got := decodeBody[errorResponse](t, rec)
			if !strings.Contains(got.Error, tc.want) {
				t.Errorf("error = %q, want prefix %q", got.Error, tc.want)
			}
		})
	}
}

func TestHandleXDisplayCreateOffline(t *testing.T) {
	// A fully valid request on an offline server answers 503 and
	// allocates nothing.
	rec := serveXDisplay(t, &api{}, http.MethodPost, "/api/xdisplay",
		`{"namespace":"ns","pod":"p1","command":["firefox"]}`)
	assertStatus(t, rec, http.StatusServiceUnavailable)
	got := decodeBody[errorResponse](t, rec)
	if !strings.Contains(got.Error, "offline") {
		t.Errorf("error = %q, want offline", got.Error)
	}
}

func TestHandleXDisplayDeleteValidation(t *testing.T) {
	t.Run("missing token and display -> 400", func(t *testing.T) {
		rec := serveXDisplay(t, &api{}, http.MethodDelete, "/api/xdisplay", "")
		assertStatus(t, rec, http.StatusBadRequest)
		got := decodeBody[errorResponse](t, rec)
		if got.Error == "" {
			t.Fatal("expected an error message")
		}
	})

	t.Run("invalid display -> 400", func(t *testing.T) {
		rec := serveXDisplay(t, &api{}, http.MethodDelete, "/api/xdisplay?display=abc", "")
		assertStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("offline -> 503", func(t *testing.T) {
		rec := serveXDisplay(t, &api{}, http.MethodDelete, "/api/xdisplay?token=abc", "")
		assertStatus(t, rec, http.StatusServiceUnavailable)
	})
}

func TestHandleXDisplayListOffline(t *testing.T) {
	rec := serveXDisplay(t, &api{source: offlineSource}, http.MethodGet, "/api/xdisplay/list", "")
	assertStatus(t, rec, http.StatusOK)
	assertJSONContentType(t, rec)

	got := decodeBody[xDisplayListResponse](t, rec)
	if got.Source != offlineSource || got.Available {
		t.Errorf("body = %+v", got)
	}
	if got.Displays == nil || len(got.Displays) != 0 {
		t.Errorf("displays = %+v, want non-nil empty slice", got.Displays)
	}
	if !strings.Contains(rec.Body.String(), `"displays":[]`) {
		t.Errorf("body = %s, want \"displays\":[]", rec.Body.String())
	}
}

func TestHandleXDisplayListLive(t *testing.T) {
	alloc := testAllocator(t)
	display, token, err := alloc.allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	alloc.record(display, token, xDisplayRequest{
		Namespace: "ns", Pod: "fire", App: "Firefox", Command: []string{"firefox"},
	}, "555")

	a := testAPI(t, alloc)
	rec := serveXDisplay(t, a, http.MethodGet, "/api/xdisplay/list", "")
	assertStatus(t, rec, http.StatusOK)

	got := decodeBody[xDisplayListResponse](t, rec)
	if !got.Available {
		t.Fatalf("available = false, want true")
	}
	if len(got.Displays) != 1 {
		t.Fatalf("displays = %+v", got.Displays)
	}
	item := got.Displays[0]
	if item.Display != display || item.App != "Firefox" || item.Pod != "fire" || item.Namespace != "ns" || item.CreatedAt == "" {
		t.Errorf("item = %+v", item)
	}
	if item.SessionAge < 0 || item.SessionAge > 5 {
		t.Errorf("sessionAge = %d, want ~0", item.SessionAge)
	}
	// Token never leaves the server via the list endpoint.
	if strings.Contains(rec.Body.String(), token) {
		t.Error("list leaked the session token")
	}
}

func TestHandleXDisplayDeleteLive(t *testing.T) {
	alloc := testAllocator(t)
	a := testAPI(t, alloc)
	display, token, err := alloc.allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	alloc.record(display, token, xDisplayRequest{Namespace: "ns", Pod: "fire", Command: []string{"firefox"}}, "55")

	// The kill/cleanup execs will fail (SPDY dials a closed port in the
	// stub rest config), but release must still happen: a zombie PID may
	// not lock a display forever.
	rec := serveXDisplay(t, a, http.MethodDelete, "/api/xdisplay?token="+token, "")
	assertStatus(t, rec, http.StatusOK)
	got := decodeBody[actionResponse](t, rec)
	if !got.OK || !strings.Contains(got.Message, "Released display :21") {
		t.Errorf("body = %+v", got)
	}
	if _, ok := alloc.lookup(token); ok {
		t.Fatal("token still valid after DELETE")
	}
	if _, ok := alloc.lookupByDisplay(display); ok {
		t.Fatal("display still busy after DELETE")
	}

	t.Run("unknown token -> 404", func(t *testing.T) {
		rec := serveXDisplay(t, a, http.MethodDelete, "/api/xdisplay?token=beef", "")
		assertStatus(t, rec, http.StatusNotFound)
	})
}

func TestHandleXDisplayDeleteByDisplayParam(t *testing.T) {
	alloc := testAllocator(t)
	a := testAPI(t, alloc)
	display, token, err := alloc.allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	alloc.record(display, token, xDisplayRequest{Namespace: "ns", Pod: "fire", Command: []string{"firefox"}}, "55")

	rec := serveXDisplay(t, a, http.MethodDelete, "/api/xdisplay?display=21", "")
	assertStatus(t, rec, http.StatusOK)
	if _, ok := alloc.lookup(token); ok {
		t.Fatal("token still valid after DELETE by display")
	}
}

func TestHandleXDisplayHealthOffline(t *testing.T) {
	rec := serveXDisplay(t, &api{source: offlineSource}, http.MethodGet, "/api/xdisplay/health", "")
	assertStatus(t, rec, http.StatusOK)
	got := decodeBody[xDisplayHealthResponse](t, rec)
	if got.Source != offlineSource || got.Available {
		t.Errorf("body = %+v", got)
	}
}

func TestHandleXDisplayHealthLive(t *testing.T) {
	t.Run("pod missing -> available false", func(t *testing.T) {
		testAllocator(t)
		a := &api{
			client:     &stubClient{},
			source:     liveSource,
			clientset:  fake.NewSimpleClientset(),
			restConfig: &rest.Config{},
			xdisplay:   newXDisplayAllocator(),
		}
		rec := serveXDisplay(t, a, http.MethodGet, "/api/xdisplay/health", "")
		assertStatus(t, rec, http.StatusOK)
		got := decodeBody[xDisplayHealthResponse](t, rec)
		if got.Source != liveSource || got.Available {
			t.Errorf("body = %+v", got)
		}
	})

	t.Run("VNC port listening -> available true", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:5921")
		if err != nil {
			t.Skipf("cannot bind 127.0.0.1:5921: %v", err)
		}
		defer listener.Close()

		alloc := testAllocator(t)
		a := &api{
			client:     &stubClient{},
			source:     liveSource,
			clientset:  fakeXServerClient(t, "127.0.0.1"),
			restConfig: &rest.Config{},
			xdisplay:   alloc,
		}
		rec := serveXDisplay(t, a, http.MethodGet, "/api/xdisplay/health", "")
		assertStatus(t, rec, http.StatusOK)
		got := decodeBody[xDisplayHealthResponse](t, rec)
		if !got.Available {
			t.Errorf("body = %+v, want available for a live listener", got)
		}
	})

	t.Run("pod up, VNC port closed -> available false", func(t *testing.T) {
		alloc := testAllocator(t)
		a := &api{
			client:     &stubClient{},
			source:     liveSource,
			clientset:  fakeXServerClient(t, "127.0.0.1"),
			restConfig: &rest.Config{},
			xdisplay:   alloc,
		}
		rec := serveXDisplay(t, a, http.MethodGet, "/api/xdisplay/health", "")
		assertStatus(t, rec, http.StatusOK)
		got := decodeBody[xDisplayHealthResponse](t, rec)
		if got.Available {
			t.Errorf("body = %+v, want available=false for a closed port", got)
		}
	})
}

func TestHandleXDisplayWSValidation(t *testing.T) {
	t.Run("missing token -> 400 before upgrade", func(t *testing.T) {
		rec := serveXDisplay(t, &api{}, http.MethodGet, "/api/xdisplay/ws", "")
		assertStatus(t, rec, http.StatusBadRequest)
	})

	t.Run("offline -> 503 before upgrade", func(t *testing.T) {
		rec := serveXDisplay(t, &api{}, http.MethodGet, "/api/xdisplay/ws?token=abc", "")
		assertStatus(t, rec, http.StatusServiceUnavailable)
	})

	t.Run("unknown token -> 404 before upgrade", func(t *testing.T) {
		a := testAPI(t, testAllocator(t))
		rec := serveXDisplay(t, a, http.MethodGet, "/api/xdisplay/ws?token=beef", "")
		assertStatus(t, rec, http.StatusNotFound)
	})
}

// TestHandleXDisplayWSProxy runs the full websockify pipeline against a
// fake RFB TCP listener: binary frames flow both directions and the stream
// closes cleanly from both ends (works offline; no cluster involved).
func TestHandleXDisplayWSProxy(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:5921")
	if err != nil {
		t.Skipf("cannot bind 127.0.0.1:5921: %v", err)
	}
	defer listener.Close()

	tcpConn := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		tcpConn <- conn
	}()

	alloc := testAllocator(t)
	display, token, err := alloc.allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	if display != 21 {
		t.Fatalf("display = %d, want 21", display)
	}

	a := testAPI(t, alloc)
	a.clientset = fakeXServerClient(t, "127.0.0.1")
	srv := httptest.NewServer(newMux(a))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/xdisplay/ws?token=" + token
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v (status %d)", err, resp.StatusCode)
	}
	defer conn.Close()

	upstream := <-tcpConn
	defer upstream.Close()

	// cluster → browser
	if _, err := upstream.Write([]byte("RFB 003.008\n")); err != nil {
		t.Fatalf("upstream write: %v", err)
	}
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read from ws: %v", err)
	}
	if string(msg) != "RFB 003.008\n" {
		t.Fatalf("browser got %q", msg)
	}

	// browser → cluster
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte{0x01, 0x02, 0x03}); err != nil {
		t.Fatalf("write to ws: %v", err)
	}
	buf := make([]byte, 32)
	upstream.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, err := upstream.Read(buf)
	if err != nil || !reflect.DeepEqual(full(buf[:n]), full([]byte{0x01, 0x02, 0x03})) {
		t.Fatalf("pod got % X, err %v; want 010203", buf[:n], err)
	}

	// Browser disconnect ends the proxy and releases the upstream.
	if err := conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second)); err != nil {
		_ = conn.Close()
	}
	deadline := time.Now().Add(2 * time.Second)
	if err := upstream.SetReadDeadline(deadline); err != nil {
		// unimportant; the read below reports the outcome
	}
	if _, err := upstream.Read(buf); err == nil {
		t.Fatal("upstream still readable after ws close")
	}
}

// TestHandleXDisplayWSDeniedOrigin proves the CORS parity for websocket
// upgrades: withCORS leaves GETs alone, so the upgrade itself must enforce
// the allowlist.
func TestHandleXDisplayWSDeniedOrigin(t *testing.T) {
	t.Setenv("KOS_ALLOWED_ORIGINS", "https://allowed.example")

	alloc := testAllocator(t)
	thea := testAPI(t, alloc)
	_, token, err := alloc.allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}

	srv := httptest.NewServer(withCORS(newMux(thea)))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/xdisplay/ws?token=" + token
	if isOriginAllowed("https://evil.example") {
		t.Fatal("env allowlist did not reject evil origin locally")
	}
	req := httptest.NewRequest(http.MethodGet, wsURL, nil)
	req.Header.Set("Origin", "https://evil.example")
	if wsUpgrader().CheckOrigin(req) {
		t.Fatal("CheckOrigin accepted a disallowed origin")
	}
	if _, resp, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Origin": []string{"https://evil.example"}}); err == nil {
		t.Fatal("websocket dial succeeded from a disallowed origin")
	} else if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("upgrade rejected with %v (status %d); want 403 forbidden", err, resp.StatusCode)
	}
}

// TestHandleXDisplayWSAllowedOrigin verifies upgrades pass for a browser
// origin that IS in the allowlist.
func TestHandleXDisplayWSAllowedOrigin(t *testing.T) {
	t.Setenv("KOS_ALLOWED_ORIGINS", "http://localhost:5173,https://allowed.example")

	alloc := testAllocator(t)
	thea := testAPI(t, alloc)
	_, token, err := alloc.allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}

	srv := httptest.NewServer(withCORS(newMux(thea)))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/xdisplay/ws?token=" + token
	if _, resp, err := websocket.DefaultDialer.Dial(wsURL, http.Header{"Origin": []string{"http://localhost:5173"}}); err == nil {
		// Upgraded; the proxy may then fail dialing the fake pod IP — the
		// origin check itself must not have blocked the upgrade.
		return
	} else if resp != nil && resp.StatusCode == http.StatusForbidden {
		t.Fatalf("websocket upgrade rejected for an allowed origin (err %v)", err)
	}
	// Otherwise: origin passed, the failure is the unreachable x11vnc leg.
}

// full equalises nil/empty byte slices for DeepEqual.
func full(b []byte) []byte {
	if b == nil {
		return []byte{}
	}
	return b
}
