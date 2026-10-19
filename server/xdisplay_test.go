package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/httpstream"
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
	kill := xKillArgs("1207")
	if !strings.Contains(kill[2], "kill -TERM -1207") || !strings.Contains(kill[2], "kill -KILL -1207") {
		t.Errorf("kill script must signal the process group: %s", kill[2])
	}
	if strings.Contains(kill[2], "sleep 1") {
		t.Errorf("kill script must not hardcode a 1s sleep: %s", kill[2])
	}
}

func TestXAuthRemoveArgsScript(t *testing.T) {
	t.Setenv("KOS_XAUTH_DB", "")
	rm := xAuthRemoveArgs(21)
	if len(rm) != 3 || rm[0] != "/bin/sh" || rm[1] != "-c" {
		t.Fatalf("xAuthRemoveArgs = %+v, want ['/bin/sh','-c',script]", rm)
	}
	// Explicit -f: the removes must target the server DB regardless of $HOME.
	// ONLY the FamilyWild row may be removed: a bare `remove ":21"` display
	// spec also strips the entrypoint's persistent family-local record that
	// in-pod clients (openbox, x11vnc) authenticate with.
	if strings.Contains(rm[2], `remove ":21"`) {
		t.Errorf("remove script must not strip the persistent display entry: %s", rm[2])
	}
	if !strings.Contains(rm[2], `xauth -f /kos/.Xauthority -q remove "#ffff#:21" 2>/dev/null`) {
		t.Errorf("remove script misses the wild-record line: %s", rm[2])
	}
	if !strings.Contains(rm[2], "; true") {
		t.Errorf("remove script must end successfully for absent entries: %s", rm[2])
	}

	t.Run("db path env override", func(t *testing.T) {
		t.Setenv("KOS_XAUTH_DB", "/data/xauth")
		rm := xAuthRemoveArgs(9)
		if !strings.Contains(rm[2], `xauth -f /data/xauth -q remove "#ffff#:9"`) {
			t.Errorf("remove script ignored the env DB path: %s", rm[2])
		}
	})
}

func TestXAuthAppendScriptAndStdin(t *testing.T) {
	t.Setenv("KOS_XAUTH_DB", "")
	script := xAuthAppendScript()
	if !strings.Contains(script, `read -r COOKIE || exit 3`) {
		t.Errorf("append script missing stdin read: %s", script)
	}
	if !strings.Contains(script, `printf %s "$COOKIE" | base64 -d >> /kos/.Xauthority || exit 3`) {
		t.Errorf("append script = %s", script)
	}

	record := []byte{0xFA, 0xCE, 0xBA, 0xBE}
	stdin := xAuthAppendStdin(record)
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSuffix(string(stdin), "\n"))
	if err != nil {
		t.Fatalf("append stdin is not valid base64: %v", err)
	}
	if !bytes.Equal(decoded, record) || !strings.HasSuffix(string(stdin), "\n") {
		t.Errorf("append stdin = %q, want base64(%x) + one newline", stdin, record)
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

	// The read line doubles as the TEMP launch diagnostic: on EOF it echoes
	// the read's exit status and the received length to stderr, then still
	// fails loudly (exit 97) on an empty cookie.
	if !strings.HasPrefix(script, `read -r COOKIE || { echo "xlaunch: read-empty rc=$? len=$(printf %s "$COOKIE" | wc -c)" >&2; [ -n "$COOKIE" ] || exit 97; }`+"\n") {
		t.Errorf("script must start with the instrumented read line: %s", script)
	}
	// The Xauthority record is pre-serialized (see xAuthFileBytes) and is
	// decoded straight into the file — stock app pods have no xauth binary.
	if !strings.Contains(script, "base64 -d > /tmp/.kos-xauth-21") {
		t.Errorf("script must decode the record straight into the Xauthority file: %s", script)
	}
	if strings.Contains(script, "xauth ") {
		t.Errorf("script must not invoke xauth (stock app pods lack the binary): %s", script)
	}
	// The GUI is launched in the BACKGROUND under setsid and the wrapper
	// prints $! (the setsid leader PID, whose pgid equals the PID) then
	// exits immediately — execRun must return while the app keeps running.
	if !strings.Contains(script, `setsid env DISPLAY=kos-xserver.kos.svc:21 XAUTHORITY=/tmp/.kos-xauth-21 'firefox' '--no-remote' </dev/null >/dev/null 2>&1 & echo $!`) {
		t.Errorf("script must background the command under setsid and echo $!: %s", script)
	}
	if !strings.HasSuffix(script, "exit 0") {
		t.Errorf("script must end with exit 0 right after backgrounding: %s", script)
	}
	if strings.Contains(script, "exec env") {
		t.Errorf("script must not exec the GUI in the wrapper's process: %s", script)
	}
	// Args with quotes stay single-quoted.
	if !strings.Contains(script, "'\\''") && !strings.Contains(script, "'firefox'") {
		t.Errorf("command not quoted: %s", script)
	}
}

// TestXLaunchStdinRecordContract pins the exact stdin bytes the launch exec
// sends: base64(record) plus ONE terminating newline. `read -r` at EOF only
// succeeds for newline-terminated input; both sides of this contract are
// asserted here and in the script check above.
func TestXLaunchStdinRecordContract(t *testing.T) {
	record := []byte{0xFA, 0xCE, 0xBA, 0xBE, 0x12, 0x34}
	stdin := xLaunchStdin(record)
	want := base64.StdEncoding.EncodeToString(record) + "\n"
	if string(stdin) != want {
		t.Fatalf("stdin = %q, want %q", stdin, want)
	}
	if !strings.HasSuffix(string(stdin), "\n") {
		t.Fatalf("stdin must end with a single terminating newline: %q", stdin)
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSuffix(string(stdin), "\n"))
	if err != nil {
		t.Fatalf("stdin payload is not valid base64: %v", err)
	}
	if !bytes.Equal(decoded, record) {
		t.Fatalf("decoded payload = %x, want %x", decoded, record)
	}
}

// TestXAuthFileBytesGolden serializes the live-observed cookie
// ad044a09d81aff580c25d368d8d998bd and pins the exact record bytes: one
// MIT-MAGIC-COOKIE-1 Xauthority entry, FamilyWild (0xFFFF) with an empty
// address, the length-prefixed display number string ("21"), then name and
// data — every length field big-endian uint16, 46 bytes total.
func TestXAuthFileBytesGolden(t *testing.T) {
	const cookieHex = "ad044a09d81aff580c25d368d8d998bd"
	raw, err := hex.DecodeString(cookieHex)
	if err != nil {
		t.Fatalf("test cookie is not hex: %v", err)
	}
	name := []byte("MIT-MAGIC-COOKIE-1")

	t.Run("display_21", func(t *testing.T) {
		displayStr := "21"
		var want []byte
		want = binary.BigEndian.AppendUint16(want, 0xFFFF) // FamilyWild
		want = binary.BigEndian.AppendUint16(want, 0)      // empty address
		want = binary.BigEndian.AppendUint16(want, uint16(len(displayStr)))
		want = append(want, displayStr...)
		want = binary.BigEndian.AppendUint16(want, uint16(len(name)))
		want = append(want, name...)
		want = binary.BigEndian.AppendUint16(want, uint16(len(raw)))
		want = append(want, raw...)

		got, err := xAuthFileBytes(cookieHex, 21)
		if err != nil {
			t.Fatalf("xAuthFileBytes(%q, 21): %v", cookieHex, err)
		}
		if len(got) != 46 {
			t.Fatalf("record length = %d, want 46", len(got))
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("record = %x, want %x", got, want)
		}
	})

	for _, tc := range []struct {
		name       string
		display    int
		numLen     int
		displayStr string
	}{
		{"display_9", 9, 1, "9"},
		{"display_100", 100, 3, "100"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := xAuthFileBytes(cookieHex, tc.display)
			if err != nil {
				t.Fatalf("xAuthFileBytes(%q, %d): %v", cookieHex, tc.display, err)
			}
			if wantLen := 46 - 2 + tc.numLen; len(got) != wantLen {
				t.Fatalf("record length = %d, want %d", len(got), wantLen)
			}
			numLen := int(binary.BigEndian.Uint16(got[4:6]))
			if numLen != tc.numLen {
				t.Errorf("numLen = %d, want %d", numLen, tc.numLen)
			}
			if string(got[6:6+numLen]) != tc.displayStr {
				t.Errorf("num bytes = %q, want %q", got[6:6+numLen], tc.displayStr)
			}
		})
	}

	for _, tc := range []struct {
		name string
		hex  string
	}{
		{"invalid hex", "zz044a09"},
		{"odd length hex", "abc"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := xAuthFileBytes(tc.hex, 21); err == nil {
				t.Fatalf("xAuthFileBytes(%q) must fail, got nil error", tc.hex)
			}
		})
	}
}

// TestXAuthFileBytesRoundTrip sanity-checks the pipe: record -> base64
// (StdEncoding, exactly what xLaunchStdin sends) -> decode -> the original
// bytes come back intact.
func TestXAuthFileBytesRoundTrip(t *testing.T) {
	record, err := xAuthFileBytes("ad044a09d81aff580c25d368d8d998bd", 21)
	if err != nil {
		t.Fatalf("xAuthFileBytes: %v", err)
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(xLaunchStdin(record))))
	if err != nil {
		t.Fatalf("base64 decode of launch stdin: %v", err)
	}
	if !bytes.Equal(record, decoded) {
		t.Fatalf("round trip mismatch: got %x, want %x", decoded, record)
	}
}

// TestXDisplaySweeper proves the TTL sweep: expired entries are purged from
// BOTH maps (token + display), the recorded process group is killed inside
// the app pod and xauth-remove runs on the xserver pod — through a fake
// executor, no cluster involved.
func TestXDisplaySweeper(t *testing.T) {
	alloc := testAllocator(t)
	t.Setenv("KOS_XAUTH_DB", "")
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
	if !strings.Contains(joined, `team-a|app-1|web|/bin/sh -c rm -f `) {
		t.Errorf("sweep never removed the app pod's cookie file; calls:\n%s", joined)
	}
	if !strings.Contains(joined, `kos|kos-xserver-0||/bin/sh -c xauth -f /kos/.Xauthority -q remove "#ffff#:21" 2>/dev/null`) {
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

	// One pass only issues the three teardown steps for the one expired
	// session (kill the app, drop its cookie file, remove the xauth row).
	if len(calls) != 3 {
		t.Fatalf("exec calls = %d (%v), want 3", len(calls), calls)
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

// TestHandleXDisplayCreateLive pins the create success path end-to-end
// through the exec seam: append on the xserver pod (record bytes on stdin),
// launch in the app pod (PID on stdout), 200 with token — and the session
// must SURVIVE the handler: the deferred failure-cleanup release must not
// fire on the success path, or every fresh token would die at once.
func TestHandleXDisplayCreateLive(t *testing.T) {
	// No idle-grace teardown in this test: the goroutine schedule itself is
	// covered by TestHandleXDisplayIdleGraceLive; here the success path and
	// its exec legs are the contract.
	t.Setenv("KOS_XDISPLAY_WS_GRACE", "0")
	alloc := testAllocator(t)
	a := testAPI(t, alloc)
	var calls []string
	a.execer = func(_ context.Context, namespace, pod, container string, command []string, stdin []byte) (string, error) {
		calls = append(calls, strings.Join([]string{namespace, pod, container, strings.Join(command, " ")}, "|"))
		if strings.Join(command, " ") != "/bin/sh -c "+xAuthAppendScript() {
			// The launch exec: PID line like the real wrapper prints.
			return "4321\n", nil
		}
		if !strings.HasSuffix(string(stdin), "\n") || string(stdin) == "\n" {
			t.Errorf("append stdin = %q, want base64 record + newline", stdin)
		}
		return "", nil
	}

	rec := serveXDisplay(t, a, http.MethodPost, "/api/xdisplay",
		`{"namespace":"appns","pod":"app-pod","container":"web","app":"xclock","command":["xclock"]}`)
	assertStatus(t, rec, http.StatusOK)
	got := decodeBody[xDisplayResponse](t, rec)
	if got.Source != liveSource || got.Display != 21 || len(got.Token) != 32 {
		t.Fatalf("body = %+v", got)
	}
	if got.WSPath != "/api/xdisplay/ws?token="+got.Token {
		t.Fatalf("wsPath = %q", got.WSPath)
	}

	// The session must still be alive for the whole lifecycle.
	s, ok := alloc.lookup(got.Token)
	if !ok {
		t.Fatal("fresh token already dead after create")
	}
	if s.display != 21 || s.pid != "4321" || s.app != "xclock" || s.namespace != "appns" || s.pod != "app-pod" || s.container != "web" {
		t.Errorf("session = %+v", s)
	}
	if _, ok := alloc.lookupByDisplay(21); !ok {
		t.Fatal("display free right after a successful create")
	}
	if len(alloc.list(time.Now())) != 1 {
		t.Fatal("list does not show the fresh session")
	}

	// Both exec legs ran, in order, against the right pods.
	if len(calls) != 2 ||
		!strings.HasPrefix(calls[0], "kos|kos-xserver-0||/bin/sh -c read -r COOKIE") ||
		!strings.HasPrefix(calls[1], "appns|app-pod|web|/bin/sh -c read -r COOKIE") {
		t.Fatalf("exec calls = %v, want append-on-xserver then launch-on-app", calls)
	}
}

// TestXDisplayWSGraceGeneration pins the reconnect-guard arithmetic of the
// idle-grace release: only the close of the NEWEST stream generation may
// free the allocation, and no combination can double-free.
func TestXDisplayWSGraceGeneration(t *testing.T) {
	alloc := testAllocator(t)

	// Generation 0 = the token never streamed; the never-streamed guard
	// fires with this generation and must free the allocation.
	d1, tok, err := alloc.allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	_ = d1
	if _, ok := alloc.releaseIfIdle(tok, 0); !ok {
		t.Fatal("never-streamed token was not reclaimed by the gen-0 fire")
	}

	// Double-fire is a no-op (already freed).
	if _, ok := alloc.releaseIfIdle(tok, 0); ok {
		t.Fatal("double idle release succeeded")
	}

	// A streamed session shadows older generations: every fire whose
	// generation is behind the newest touch must leave it alone.
	d2, tok2, err := alloc.allocate()
	if err != nil || d2 != 21 {
		t.Fatalf("second allocate: %v", err)
	}
	if gen := alloc.touchWSGen(d2); gen != 1 {
		t.Fatalf("first touch gen = %d, want 1", gen)
	}
	if _, ok := alloc.releaseIfIdle(tok2, 0); ok {
		t.Fatal("gen-0 fire reclaimed a streamed session")
	}
	if _, ok := alloc.releaseIfIdle(tok2, 7); ok {
		t.Fatal("future-generation fire reclaimed a streamed session")
	}
	if gen := alloc.touchWSGen(d2); gen != 2 {
		t.Fatalf("second touch gen = %d, want 2", gen)
	}
	if _, ok := alloc.releaseIfIdle(tok2, 1); ok {
		t.Fatal("stale generation reclaimed the session after a reconnect")
	}

	// The newest generation frees it exactly once.
	s, ok := alloc.releaseIfIdle(tok2, 2)
	if !ok || s.token != tok2 || s.display != d2 {
		t.Fatalf("newest-gen release: (%+v, %v)", s, ok)
	}
	if _, tok3, err := alloc.allocate(); err != nil || tok3 == tok2 {
		t.Fatalf("display not freed by the idle release: %v", err)
	}
	if _, ok := alloc.releaseIfIdle(tok2, 2); ok {
		t.Fatal("double newest-gen release succeeded")
	}
}

// TestHandleXDisplayIdleGraceLive drives the leaked-session safety net
// through real handlers: a POST whose stream never opens is torn down by
// the gen-0 fire; a POST whose stream dies is torn down by the newest-
// generation fire exactly once, with the full teardown exec triple.
func TestHandleXDisplayIdleGraceLive(t *testing.T) {
	newAPI := func(t *testing.T, calls *[]string) (*xDisplayAllocator, *api) {
		t.Helper()
		alloc := testAllocator(t)
		a := testAPI(t, alloc)
		a.clientset = fakeXServerClient(t, "127.0.0.1")
		a.execer = func(_ context.Context, namespace, pod, container string, command []string, _ []byte) (string, error) {
			*calls = append(*calls, strings.Join([]string{namespace, pod, container, strings.Join(command, " ")}, "|"))
			if strings.Join(command, " ") == "/bin/sh -c "+xAuthAppendScript() {
				return "", nil
			}
			return "4321\n", nil
		}
		return alloc, a
	}
	body := `{"namespace":"appns","pod":"app-pod","container":"web","app":"xclock","command":["xclock"]}`

	t.Run("never streamed", func(t *testing.T) {
		t.Setenv("KOS_XDISPLAY_WS_GRACE", "50ms")
		var calls []string
		alloc, a := newAPI(t, &calls)
		rec := serveXDisplay(t, a, http.MethodPost, "/api/xdisplay", body)
		assertStatus(t, rec, http.StatusOK)
		token := decodeBody[xDisplayResponse](t, rec).Token
		deadline := time.Now().Add(3 * time.Second)
		for {
			if _, ok := alloc.lookup(token); !ok {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("never-streamed session survived the idle grace")
			}
			time.Sleep(20 * time.Millisecond)
		}
		joined := strings.Join(calls, "\n")
		if !strings.Contains(joined, "appns|app-pod|web|/bin/sh -c kill -TERM -4321") {
			t.Errorf("gen-0 fire never killed the app; calls:\n%s", joined)
		}
		if !strings.Contains(joined, `kos|kos-xserver-0||/bin/sh -c xauth -f`) {
			t.Errorf("gen-0 fire never removed the xauth row; calls:\n%s", joined)
		}
	})

	t.Run("stream closed", func(t *testing.T) {
		t.Setenv("KOS_XDISPLAY_WS_GRACE", "150ms")
		t.Setenv("KOS_XDISPLAY_DIALER", "direct")
		var calls []string
		alloc, a := newAPI(t, &calls)
		rec := serveXDisplay(t, a, http.MethodPost, "/api/xdisplay", body)
		assertStatus(t, rec, http.StatusOK)
		token := decodeBody[xDisplayResponse](t, rec).Token

		srv := httptest.NewServer(newMux(a))
		defer srv.Close()
		ws, _, err := websocket.DefaultDialer.Dial(
			"ws"+strings.TrimPrefix(srv.URL, "http")+"/api/xdisplay/ws?token="+token, nil)
		if err != nil {
			t.Fatalf("dial ws: %v", err)
		}
		ws.SetReadDeadline(time.Now().Add(3 * time.Second))
		if _, _, rerr := ws.ReadMessage(); rerr == nil {
			t.Fatal("expected a close after the failed upstream dial")
		}
		ws.Close()

		deadline := time.Now().Add(3 * time.Second)
		for {
			if _, ok := alloc.lookup(token); !ok {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("closed-stream session survived the idle grace")
			}
			time.Sleep(20 * time.Millisecond)
		}

		joined := strings.Join(calls, "\n")
		// Create legs (append + launch) then the teardown triple — each
		// exactly once; the create-fire (gen 0) must NOT tear down, only
		// the newest-generation fire from the stream close does. NOTE: one
		// xauth call is a single script line containing two removes (the
		// plain and the wild row), so count CALLS, not phrase hits.
		if got := strings.Count(joined, "kill -TERM -4321"); got != 1 {
			t.Errorf("kill leg ran %d times, want 1; calls:\n%s", got, joined)
		}
		var xauthCalls int
		for _, call := range calls {
			if strings.Contains(call, "xauth -f /kos/.Xauthority -q remove") {
				xauthCalls++
			}
		}
		if xauthCalls != 1 {
			t.Errorf("xauth remove ran %d calls, want 1; calls:\n%s", xauthCalls, joined)
		}
		// Display freed for reallocation (pool is 2).
		if _, _, err := alloc.allocate(); err != nil {
			t.Fatalf("display not freed after idle-grace teardown: %v", err)
		}
	})
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
		// Direct dialer semantics; the portfw probe of this same situation
		// is covered by "pod scheduled -> available true" below.
		t.Setenv("KOS_XDISPLAY_DIALER", "direct")
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
		// Direct dialer semantics: the TCP probe decides availability even
		// though the pod itself answers.
		t.Setenv("KOS_XDISPLAY_DIALER", "direct")
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

	t.Run("pod scheduled -> available true (portfw probe)", func(t *testing.T) {
		// Port-forward mode serves kos-server from outside the cluster: a
		// pod-IP TCP probe would always fail, so availability is the pod
		// get alone — even with nothing listening (the ws probe would
		// succeed if there were nothing here).
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
			t.Errorf("body = %+v, want available by pod get alone in portfw mode", got)
		}
	})

	t.Run("pod without IP -> available false (portfw probe)", func(t *testing.T) {
		alloc := testAllocator(t)
		a := &api{
			client:     &stubClient{},
			source:     liveSource,
			clientset:  fakeXServerClient(t, ""),
			restConfig: &rest.Config{},
			xdisplay:   alloc,
		}
		rec := serveXDisplay(t, a, http.MethodGet, "/api/xdisplay/health", "")
		assertStatus(t, rec, http.StatusOK)
		got := decodeBody[xDisplayHealthResponse](t, rec)
		if got.Available {
			t.Errorf("body = %+v, want available=false for an unscheduled pod", got)
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
// Direct dialer mode, since this test stands in for an in-cluster
// deployment with a convincing pod IP; the port-forward leg has its own
// fake-dialer test below.
func TestHandleXDisplayWSProxy(t *testing.T) {
	t.Setenv("KOS_XDISPLAY_DIALER", "direct")

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

// ---------------------------------------------------------------------------
// KOS_XDISPLAY_DIALER + api-server port-forward tests
// ---------------------------------------------------------------------------

func TestXDisplayDialerModeEnv(t *testing.T) {
	cases := []struct {
		set  string
		want xDisplayDialerMode
	}{
		{"", xDialerPortFw},         // default: port-forward tunnel
		{"portfw", xDialerPortFw},   // explicit default
		{"direct", xDialerDirect},   // legacy direct dial
		{"DIRECT", xDialerDirect},   // case-insensitive
		{" direct ", xDialerDirect}, // tolerant trim
		{"garbage", xDialerPortFw},  // unknown values fall back to the tunnel
	}
	for _, tc := range cases {
		t.Run("env="+tc.set, func(t *testing.T) {
			t.Setenv("KOS_XDISPLAY_DIALER", tc.set)
			if got := xdisplayDialerMode(); got != tc.want {
				t.Fatalf("xdisplayDialerMode() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestXPortForwardRequestURL(t *testing.T) {
	raw, err := xPortForwardRequestURL(&rest.Config{Host: "https://apiserver.example:6443"},
		"kos", "kos-xserver-0", 5921)
	if err != nil {
		t.Fatalf("xPortForwardRequestURL: %v", err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("built url %q: %v", raw, err)
	}
	if u.Host != "apiserver.example:6443" || u.Path != "/api/v1/namespaces/kos/pods/kos-xserver-0/portforward" {
		t.Fatalf("url = %q", u)
	}
	if q := u.Query().Get("ports"); q != "5921" {
		t.Fatalf("ports = %q, want 5921", q)
	}

	for _, bad := range []struct {
		ns, pod string
		port    int
	}{{"../etc", "p", 5921}, {"kos", "p p", 5921}, {"kos", "x", 0}, {"kos", "x", 70000}} {
		if _, err := xPortForwardRequestURL(&rest.Config{Host: "https://a.there"}, bad.ns, bad.pod, bad.port); err == nil {
			t.Errorf("xPortForwardRequestURL(%q, %q, %d) accepted garbage", bad.ns, bad.pod, bad.port)
		}
	}
}

// TestXPodDialerDeadAPIServer pins the bounded, descriptive failure of the
// port-forward dial when the apiserver cannot be reached at all (no tunnel
// in the test environment): both dialers fail fast.
func TestXPodDialerDeadAPIServer(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	_, err := xPodDialer(ctx, &rest.Config{Host: "http://127.0.0.1:1"}, "kos", "kos-xserver-0", 5921)
	if err == nil {
		t.Fatal("dialer succeeded against a closed apiserver port")
	}
	for _, want := range []string{"port-forward", "kos", "kos-xserver-0", "5921"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q misses %q", err, want)
		}
	}
}

// TestXPodDialerBoundedByContext proves the dial is bounded: an apiserver
// that accepts the connection but never completes the upgrade cannot stall
// the dialer past the (caller-supplied, here shortened) budget.
func TestXPodDialerBoundedByContext(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Never answer the upgrade. The tunneling dialer issues its
		// roundtrip on a background context (client-go keeps no ctx
		// parameter), so the caller's cancelation cannot unwind it — the
		// test therefore self-releases the stuck handler instead of
		// blocking srv.Close() on it forever.
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err := xPodDialer(ctx, &rest.Config{Host: srv.URL}, "kos", "kos-xserver-0", 5921)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("dialer succeeded against a hanging apiserver")
	}
	if !strings.Contains(err.Error(), "not ready after") {
		t.Errorf("error = %q, want the bounded 'not ready after …' failure", err)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("dial took %s, want a ~250ms bound", elapsed)
	}
}

// fakePFStream is one port-forward stream end (minimal httpstream.Stream).
type fakePFStream struct {
	read    *io.PipeReader
	write   *io.PipeWriter
	headers http.Header
}

func (s *fakePFStream) Read(p []byte) (int, error)  { return s.read.Read(p) }
func (s *fakePFStream) Write(p []byte) (int, error) { return s.write.Write(p) }
func (s *fakePFStream) Close() error {
	s.read.Close()
	s.write.Close()
	return nil
}
func (s *fakePFStream) Reset() error         { return s.read.Close() }
func (s *fakePFStream) Headers() http.Header { return s.headers }
func (s *fakePFStream) Identifier() uint32   { return 7 }

// fakePFConn mimics the upgraded portforward httpstream.Connection: every
// CreateStream answers with a pipe-backed stream (unless seeded to fail);
// the far ends are kept for the test to read client-side writes and push
// apiserver-side bytes.
type fakePFConn struct {
	mu         sync.Mutex
	remote     map[string]*fakePFStream // far ends by corev1.StreamType+"-r"
	requestIDs []string                 // one per created stream
	nextErr    error
	closed     chan struct{}
	closeOnce  sync.Once
}

func newFakePFConn(err error) *fakePFConn {
	return &fakePFConn{remote: map[string]*fakePFStream{}, closed: make(chan struct{}), nextErr: err}
}

func (c *fakePFConn) CreateStream(headers http.Header) (httpstream.Stream, error) {
	if c.nextErr != nil {
		return nil, c.nextErr
	}
	clientR, remoteW := io.Pipe() // kos-server → apiserver
	remoteR, clientW := io.Pipe() // apiserver → kos-server
	kind := headers.Get(corev1.StreamType)
	c.mu.Lock()
	c.remote[kind+"-r"] = &fakePFStream{read: remoteR, write: remoteW, headers: headers.Clone()}
	c.requestIDs = append(c.requestIDs, headers.Get(corev1.PortForwardRequestIDHeader))
	c.mu.Unlock()
	return &fakePFStream{read: clientR, write: clientW, headers: headers.Clone()}, nil
}

func (c *fakePFConn) Close() error {
	c.closeOnce.Do(func() {
		c.mu.Lock()
		for _, s := range c.remote {
			s.read.Close()
			s.write.Close()
		}
		c.mu.Unlock()
		close(c.closed)
	})
	return nil
}

func (c *fakePFConn) CloseChan() <-chan bool             { return nil }
func (c *fakePFConn) SetIdleTimeout(time.Duration)       {}
func (c *fakePFConn) RemoveStreams(...httpstream.Stream) {}

func TestXForwardedConnStreams(t *testing.T) {
	conn := newFakePFConn(nil)

	upstream, err := xForwardedConn(conn, 5921)
	if err != nil {
		t.Fatalf("xForwardedConn: %v", err)
	}

	// Stream headers must follow the portforward dialect (the same pair
	// PortForwarder.handleConnection writes).
	conn.mu.Lock()
	errStream := conn.remote[corev1.StreamTypeError+"-r"]
	conn.mu.Unlock()
	if errStream == nil {
		t.Fatal("no error stream created")
	}
	if h := errStream.headers.Get(corev1.PortHeader); h != "5921" {
		t.Errorf("PortHeader = %q, want 5921", h)
	}
	if h := errStream.headers.Get(corev1.StreamType); h != corev1.StreamTypeError {
		t.Errorf("error StreamType = %q", h)
	}
	conn.mu.Lock()
	ids := conn.requestIDs
	conn.mu.Unlock()
	// Both streams of the pair carry the same requestID (the forwarding
	// request layout PortForwarder.handleConnection uses).
	if len(ids) != 2 || ids[0] == "" || ids[0] != ids[1] {
		t.Fatalf("requestID headers = %v, want the same non-empty id on both streams of the pair", ids)
	}

	// kos-server → apiserver → far end. The remote reader runs first: pipe
	// writes block until a reader shows up.
	buf := make([]byte, 32)
	remoteGot := make(chan string, 1)
	conn.mu.Lock()
	dataRemote := conn.remote[corev1.StreamTypeData+"-r"]
	conn.mu.Unlock()
	go func() {
		n, _ := dataRemote.read.Read(buf)
		remoteGot <- string(buf[:n])
	}()
	if _, err := upstream.Write([]byte("RFB 003.008\n")); err != nil {
		t.Fatalf("upstream write: %v", err)
	}
	if got := <-remoteGot; got != "RFB 003.008\n" {
		t.Fatalf("remote got %q", got)
	}

	// apiserver → kos-server: the remote pushes bytes into the data
	// stream and the net.Conn surface delivers them.
	go func() {
		_, _ = dataRemote.write.Write([]byte("vnc-frame"))
	}()
	_ = upstream.SetReadDeadline(time.Now().Add(2 * time.Second)) // accepted no-op
	n, err := upstream.Read(buf)
	if err != nil || string(buf[:n]) != "vnc-frame" {
		t.Fatalf("upstream read = %q, %v", buf[:n], err)
	}

	// An apiserver-reported forwarding error tears the connection down:
	// the proxy legs must observe it (abrupt close propagation).
	if _, err := errStream.write.Write([]byte("port forward setup failed")); err != nil {
		t.Fatalf("error-stream write: %v", err)
	}
	select {
	case <-conn.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("apiserver error text never propagated to conn close")
	}
	if _, rerr := upstream.Read(buf); rerr == nil {
		t.Fatal("upstream still readable after apiserver error")
	}
}

func TestXForwardedConnCreateStreamFailure(t *testing.T) {
	conn := newFakePFConn(errors.New("stream rejected"))
	if _, err := xForwardedConn(conn, 5921); err == nil {
		t.Fatal("create-stream failure must fail the wrap")
	}
	select {
	case <-conn.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("create-stream failure must close the connection")
	}
}

func TestXForwardedConnRequestIDsUnique(t *testing.T) {
	c1 := newFakePFConn(nil)
	if _, err := xForwardedConn(c1, 5921); err != nil {
		t.Fatalf("wrap 1: %v", err)
	}
	c2 := newFakePFConn(nil)
	if _, err := xForwardedConn(c2, 5922); err != nil {
		t.Fatalf("wrap 2: %v", err)
	}
	c1.mu.Lock()
	id1 := c1.requestIDs[0]
	c1.mu.Unlock()
	c2.mu.Lock()
	id2 := c2.requestIDs[0]
	c2.mu.Unlock()
	if id1 == "" || id1 == id2 {
		t.Fatalf("requestIDs must be unique per forward: %q vs %q", id1, id2)
	}
}

// readWithTimeout reads from a plain io.Reader (no deadline support) with a
// bound, so a stuck pipe read fails the test instead of hanging it.
func readWithTimeout(r io.Reader, buf []byte, budget time.Duration) (int, error) {
	type result struct {
		n   int
		err error
	}
	done := make(chan result, 1)
	go func() {
		n, err := r.Read(buf)
		done <- result{n, err}
	}()
	select {
	case res := <-done:
		return res.n, res.err
	case <-time.After(budget):
		return 0, errors.New("read did not complete in time")
	}
}

// seamNetConn is a net.Conn standing in for the cluster leg of proxyRFB in
// the fake-dialer test: both halves are io.Pipe pairs the test controls,
// and Close signals the test so propagation can be asserted.
type seamNetConn struct {
	readR     *io.PipeReader
	readW     *io.PipeWriter
	writeR    *io.PipeReader
	writeW    *io.PipeWriter
	closed    chan struct{}
	closeOnce sync.Once
}

func (c *seamNetConn) Read(p []byte) (int, error)  { return c.readR.Read(p) }
func (c *seamNetConn) Write(p []byte) (int, error) { return c.writeW.Write(p) }
func (c *seamNetConn) Close() error {
	c.closeOnce.Do(func() {
		c.readR.Close()
		c.writeR.Close()
		close(c.closed)
	})
	return nil
}
func (c *seamNetConn) LocalAddr() net.Addr              { return xForwardedAddr{} }
func (c *seamNetConn) RemoteAddr() net.Addr             { return xForwardedAddr{} }
func (c *seamNetConn) SetDeadline(time.Time) error      { return nil }
func (c *seamNetConn) SetReadDeadline(time.Time) error  { return nil }
func (c *seamNetConn) SetWriteDeadline(time.Time) error { return nil }

// TestHandleXDisplayWSPortFwDialerSeam runs the full websockify pipeline in
// the (default) portfw mode with an injected fake dialer: the handler hands
// proxyRFB whatever xDial returns, binary frames flow both directions,
// xDial receives the session coordinates, and closing the browser side
// propagates the close into the dialed conn.
func TestHandleXDisplayWSPortFwDialerSeam(t *testing.T) {
	alloc := testAllocator(t)
	display, token, err := alloc.allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	// The session's namespace/pod identify the APP pod the GUI runs in;
	// the port-forward leg must ignore them and dial the X SERVER pod.
	alloc.record(display, token, xDisplayRequest{
		Namespace: "appns", Pod: "app-pod", Command: []string{"firefox"},
	}, "77")

	a := testAPI(t, alloc)

	// Fake cluster leg: browser-facing on one half, test-controlled bytes
	// on the other half of each pipe pair.
	conn := &seamNetConn{closed: make(chan struct{})}
	conn.readR, conn.readW = io.Pipe()
	conn.writeR, conn.writeW = io.Pipe()
	dialed := make(chan chan struct{}, 1)

	a.xdialer = func(ctx context.Context, namespace, pod string, port int) (net.Conn, error) {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		coord := newXServerCoord()
		if namespace != coord.namespace || pod != coord.pod || port != 5900+display {
			t.Errorf("xDial = %s/%s port %d, want the xserver pod %s/%s port 5900+%d",
				namespace, pod, port, coord.namespace, coord.pod, display)
		}
		select {
		case dialed <- conn.closed:
		default:
		}
		return conn, nil
	}

	srv := httptest.NewServer(newMux(a))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/xdisplay/ws?token=" + token
	browser, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v (status %v)", err, resp.StatusCode)
	}
	defer browser.Close()

	select {
	case <-dialed:
	case <-time.After(2 * time.Second):
		t.Fatal("handler never dialed the fake port-forward leg")
	}

	// cluster → browser
	go func() {
		_, _ = conn.readW.Write([]byte("RFB 003.008\n"))
	}()
	browser.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, msg, err := browser.ReadMessage()
	if err != nil {
		t.Fatalf("browser read: %v", err)
	}
	if string(msg) != "RFB 003.008\n" {
		t.Fatalf("browser got %q, want RFB banner", msg)
	}

	// browser → cluster
	if err := browser.WriteMessage(websocket.BinaryMessage, []byte{0x01, 0x02}); err != nil {
		t.Fatalf("browser write: %v", err)
	}
	buf := make([]byte, 32)
	if n, rerr := readWithTimeout(conn.writeR, buf, 2*time.Second); rerr != nil || string(buf[:n]) != "\x01\x02" {
		t.Fatalf("cluster got % X, %v; want 0102", buf[:n], rerr)
	}

	// Browser disconnect must reach the fake dialer's conn (close
	// propagation through proxyRFB) with a clean close handshake.
	if err := browser.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second)); err != nil {
		_ = browser.Close()
	}
	select {
	case <-conn.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("browser close did not propagate into the dialed conn")
	}
}
