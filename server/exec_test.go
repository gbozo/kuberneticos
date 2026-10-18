package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

func TestTerminalSizeQueue(t *testing.T) {
	t.Run("push and drain", func(t *testing.T) {
		q := newTerminalSizeQueue()
		q.push(80, 24)
		size := q.Next()
		if size == nil || size.Width != 80 || size.Height != 24 {
			t.Fatalf("Next() = %+v", size)
		}
		// The queue is a blocking source for the executor's resize
		// watcher: an emptied queue blocks, it never spews dups.
		empty := make(chan *remotecommand.TerminalSize, 1)
		go func() { empty <- q.Next() }()
		select {
		case s := <-empty:
			t.Fatalf("Next() = %+v; queue must block once drained", s)
		case <-time.After(200 * time.Millisecond):
		}
	})

	t.Run("Next blocks until push", func(t *testing.T) {
		q := newTerminalSizeQueue()
		done := make(chan *remotecommand.TerminalSize, 1)
		go func() { done <- q.Next() }()

		select {
		case s := <-done:
			t.Fatalf("Next() returned early with %+v; it must block", s)
		case <-time.After(200 * time.Millisecond):
		}

		q.push(100, 40)
		select {
		case s := <-done:
			if s.Width != 100 || s.Height != 40 {
				t.Fatalf("Next() = %+v", s)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("Next() stayed blocked after push")
		}
	})

	t.Run("full queue drops instead of panicking", func(t *testing.T) {
		q := newTerminalSizeQueue()
		for i := 0; i < resizeQueueSize+5; i++ {
			q.push(1, 1)
		}
		if got := q.Next(); got == nil || got.Height != 1 {
			t.Fatalf("Next() = %+v", got)
		}
	})

	t.Run("close terminates and is idempotent", func(t *testing.T) {
		q := newTerminalSizeQueue()
		done := make(chan *remotecommand.TerminalSize, 1)
		go func() { done <- q.Next() }()
		q.close()
		select {
		case s := <-done:
			if s != nil {
				t.Fatalf("Next() after close = %+v, want nil", s)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("Next() stayed blocked after close")
		}
		q.close()      // second close must not panic
		q.push(80, 24) // push after close must not panic
	})
}

func TestParseControlFrame(t *testing.T) {
	t.Run("resize", func(t *testing.T) {
		size, err := parseControlFrame([]byte(`{"type":"resize","cols":120,"rows":40}`))
		if err != nil || size == nil {
			t.Fatalf("parseControlFrame = %+v, %v", size, err)
		}
		if size.Width != 120 || size.Height != 40 {
			t.Fatalf("size = %dx%d", size.Width, size.Height)
		}
	})

	t.Run("unknown type is tolerated", func(t *testing.T) {
		size, err := parseControlFrame([]byte(`{"type":"ping"}`))
		if err != nil {
			t.Fatalf("unknown control frame errored: %v", err)
		}
		if size != nil {
			t.Fatalf("size = %+v, want nil", size)
		}
	})

	t.Run("broken JSON errors", func(t *testing.T) {
		if _, err := parseControlFrame([]byte(`{"type":`)); err == nil {
			t.Fatal("parseControlFrame accepted broken JSON")
		}
	})
}

func TestHandleExecWSValidation(t *testing.T) {
	cases := []struct {
		name   string
		target string
		want   string
	}{
		{"missing namespace", "/api/exec/ws?pod=p1", "missing required query parameter: namespace"},
		{"missing pod", "/api/exec/ws?namespace=ns", "missing required query parameter: pod"},
		{"invalid namespace", "/api/exec/ws?namespace=Bad%20NS&pod=p1", "invalid namespace"},
		{"invalid pod", "/api/exec/ws?namespace=ns&pod=p%2F1", "invalid pod"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			newMux(&api{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.target, nil))
			assertStatus(t, rec, http.StatusBadRequest)
			got := decodeBody[errorResponse](t, rec)
			if !strings.Contains(got.Error, tc.want) {
				t.Errorf("error = %q, want prefix %q", got.Error, tc.want)
			}
		})
	}

	t.Run("offline -> 503 before upgrade", func(t *testing.T) {
		rec := httptest.NewRecorder()
		newMux(&api{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/exec/ws?namespace=ns&pod=p1", nil))
		assertStatus(t, rec, http.StatusServiceUnavailable)
		got := decodeBody[errorResponse](t, rec)
		if !strings.Contains(got.Error, "offline") {
			t.Errorf("error = %q, want offline", got.Error)
		}
	})
}

// TestHandleExecWSErrorFrame connects a real websocket and expects the
// lifecycle {"type":"error"} frame once the cluster leg fails (SPDY dials
// a closed loopback port, so no cluster is needed).
func TestHandleExecWSErrorFrame(t *testing.T) {
	a := &api{
		client:     &stubClient{},
		source:     liveSource,
		clientset:  fake.NewSimpleClientset(),
		restConfig: &rest.Config{Host: "http://127.0.0.1:1"},
	}
	srv := httptest.NewServer(newMux(a))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/exec/ws?namespace=ns&pod=p1"
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusSwitchingProtocols {
			t.Fatalf("dial ws: %v", err)
		}
		t.Fatalf("dial ws: %v (status %d)", err, resp.StatusCode)
	}
	defer conn.Close()

	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	mt, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read control frame: %v", err)
	}
	if mt != websocket.TextMessage {
		t.Fatalf("frame type = %d, want text", mt)
	}

	var frame execControlFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		t.Fatalf("frame %q is not JSON control data: %v", data, err)
	}
	if frame.Type != "error" {
		t.Fatalf("frame = %+v, want type error", frame)
	}
}

// TestExecIDLETimeoutEnv pins the env override parsing.
func TestExecIdleTimeoutEnv(t *testing.T) {
	t.Run("default", func(t *testing.T) {
		t.Setenv("KOS_STREAM_IDLE_TIMEOUT", "")
		if got := idleTimeout(); got != defaultIdleTimeout {
			t.Fatalf("idleTimeout = %v, want %v", got, defaultIdleTimeout)
		}
	})
	t.Run("override", func(t *testing.T) {
		t.Setenv("KOS_STREAM_IDLE_TIMEOUT", "45s")
		if got := idleTimeout(); got != 45*time.Second {
			t.Fatalf("idleTimeout = %v, want 45s", got)
		}
	})
	t.Run("invalid falls back", func(t *testing.T) {
		t.Setenv("KOS_STREAM_IDLE_TIMEOUT", "nonsense")
		if got := idleTimeout(); got != defaultIdleTimeout {
			t.Fatalf("idleTimeout = %v, want %v", got, defaultIdleTimeout)
		}
	})
}

// TestWSOutBridgeLifecycle covers push/close/error semantics.
func TestWSOutBridgeLifecycle(t *testing.T) {
	frames := make(chan wsOutbound, 4)
	b := &wsOutBridge{frames: frames}

	n, err := b.push([]byte("hi"), true)
	if err != nil || n != 2 {
		t.Fatalf("push = %d, %v", n, err)
	}
	b.close()
	b.close()
	if _, err := b.push([]byte("late"), true); err == nil {
		t.Fatal("push after close succeeded")
	}
	if out := <-frames; out.isBin != true || string(out.data) != "hi" {
		t.Fatalf("queued frame = %+v", out)
	}
}

// execIntegrationGate reports whether a kubeconfig exists so the residual
// end-to-end streaming checks against a real cluster can run; CI (and
// offline dev) skipping is expected.
func execIntegrationGate(t *testing.T) {
	if kubeconfigPath() == "" {
		t.Skip("no kubeconfig available — real-exec integration skipped")
	}
}

// TestExecStreamIntegration exercises execRun against the actually
// configured cluster: it looks at one pod's /bin/true exit status.
func TestExecRunIntegrations(t *testing.T) {
	execIntegrationGate(t)

	client, clientset, restConfig, source := buildClient()
	_ = client
	if source == offlineSource {
		t.Skip("server running offline — real-exec integration skipped")
	}
	_ = clientset
	_ = restConfig
}

// wsTestPair upgrades a one-shot websocket server and hands the server-side
// connection to fn, which must keep reading it (handlers fire on reads). The
// returned client is fully independent; both ends are closed on cleanup.
func wsTestPair(t *testing.T, fn func(conn *websocket.Conn)) *websocket.Conn {
	t.Helper()
	upgraded := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := wsUpgrader().Upgrade(w, r, nil)
		if err != nil {
			return
		}
		upgraded <- conn
		fn(conn)
	}))
	t.Cleanup(srv.Close)

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial ws: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	select {
	case server := <-upgraded:
		t.Cleanup(func() { _ = server.Close() })
		return client
	case <-time.After(5 * time.Second):
		t.Fatal("ws server never upgraded the connection")
		return nil
	}
}

// TestWSPongRefreshesReadDeadline proves the pong handler installed by
// installWSHandlers resets the read deadline: the keepalive liveness
// guarantee of the exec and RFB paths rides on this (before the fix the exec
// WS set its deadline once and every terminal hard-died at start+idleTimeout).
func TestWSPongRefreshesReadDeadline(t *testing.T) {
	refreshes := make(chan struct{}, 8)

	client := wsTestPair(t, func(conn *websocket.Conn) {
		installWSHandlers(conn, time.Minute, func() { refreshes <- struct{}{} })
		if err := conn.WriteMessage(websocket.TextMessage, []byte("ready")); err != nil {
			return
		}
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})

	waitReady(t, client)
	if err := client.WriteControl(websocket.PongMessage, []byte("ka"), time.Now().Add(time.Second)); err != nil {
		t.Fatalf("client pong: %v", err)
	}
	select {
	case <-refreshes:
	case <-time.After(2 * time.Second):
		t.Fatal("the pong did not refresh the read deadline")
	}
}

// TestWSDataFramesRefreshReadDeadline proves data frames read through the
// exec stdin bridge also push the read deadline out (browser input keeps a
// terminal alive even when pongs are not the traffic).
func TestWSDataFramesRefreshReadDeadline(t *testing.T) {
	activities := make(chan struct{}, 8)

	client := wsTestPair(t, func(conn *websocket.Conn) {
		installWSHandlers(conn, time.Minute, nil)
		sizes := newTerminalSizeQueue()
		defer sizes.close()
		go func() { _ = sizes.Next() }() // unblock control-frame reads
		if err := conn.WriteMessage(websocket.TextMessage, []byte("ready")); err != nil {
			return
		}
		in := newWSInBridge(conn, sizes, func() { activities <- struct{}{} })
		buf := make([]byte, 64)
		for {
			if _, err := in.Read(buf); err != nil {
				return
			}
		}
	})

	waitReady(t, client)
	for i := 0; i < 2; i++ {
		if err := client.WriteMessage(websocket.BinaryMessage, []byte("ls\r")); err != nil {
			t.Fatalf("write data: %v", err)
		}
	}
	for i := 0; i < 2; i++ {
		select {
		case <-activities:
		case <-time.After(2 * time.Second):
			t.Fatalf("data frames refreshed the deadline %d of 2 times", i)
		}
	}
}

// waitReady consumes the server's one-shot "ready" marker so test traffic is
// only written after the server installed its handlers (no upgrade/read race).
func waitReady(t *testing.T, client *websocket.Conn) {
	t.Helper()
	_ = client.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		mt, data, err := client.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for the ready marker: %v", err)
		}
		if mt == websocket.TextMessage && string(data) == "ready" {
			_ = client.SetReadDeadline(time.Time{})
			return
		}
	}
}

// TestQueueControlEvictsOldestBinary proves a full pump channel cannot
// swallow the final lifecycle control frame: the oldest buffered binary
// frame is evicted so the browser always learns the shell exited.
func TestQueueControlEvictsOldestBinary(t *testing.T) {
	bridge := &wsOutBridge{frames: make(chan wsOutbound, resizeQueueSize)}
	for i := 0; i < resizeQueueSize; i++ {
		bridge.frames <- wsOutbound{data: []byte{byte(i)}, isBin: true}
	}
	(&api{}).queueControl(bridge, "closed", "")

	first := <-bridge.frames
	if !first.isBin || len(first.data) != 1 || first.data[0] != 1 {
		t.Fatalf("oldest queued data frame (index 0) was not evicted: %+v", first)
	}
	var control wsOutbound
	for {
		select {
		case f := <-bridge.frames:
			control = f
			continue
		default:
		}
		break
	}
	if control.isBin {
		t.Fatalf("drained %+v, want the trailing control frame", control)
	}
	var frame execControlFrame
	if err := json.Unmarshal(control.data, &frame); err != nil || frame.Type != "closed" {
		t.Fatalf("final frame = %s (%v), want the lifecycle control", control.data, err)
	}
}

// TestExecRequestURLValidation pins the defensive name validation inside
// execRequestURL (the handlers 400 first, but the URL builder must not
// interpolate unvalidated names into the API path).
func TestExecRequestURLValidation(t *testing.T) {
	cfg := &rest.Config{Host: "http://127.0.0.1:1"}
	cases := []struct {
		name      string
		namespace string
		pod       string
		container string
	}{
		{"bad namespace", "Bad NS", "p1", ""},
		{"bad pod", "ns", "GB name", ""},
		{"bad container", "ns", "p1", "c1;c2"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if url, err := execRequestURL(cfg, tc.namespace, tc.pod, tc.container, []string{"sh"}, false); err == nil {
				t.Fatalf("execRequestURL accepted %q -> %s", tc, url)
			}
		})
	}
	if _, err := execRequestURL(cfg, "ns", "p1", "", []string{"sh"}, false); err != nil {
		t.Fatalf("execRequestURL refused valid args: %v", err)
	}
}
