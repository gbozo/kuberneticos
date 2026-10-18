// Terminal and in-pod exec support for the KuberneticOS API server.
//
// This file owns all client-go remotecommand usage: a short-lived
// run-command helper (used by xdisplay.go for xauth provisioning, app
// launch and release cleanup) and the long-lived /api/exec/ws terminal
// bridge that streams a browser websocket to a shell inside a pod.
//
// Bipartite timeout strategy: ordinary JSON requests are bounded by the
// withRequestTimeout middleware (15s context budget). The websocket streams
// here are long-lived by design, so they derive a cancel-detached context
// (context.WithoutCancel) for the cluster leg and enforce liveness
// themselves — ping/pong keepalive, per-read deadlines and an idle timeout —
// instead of inheriting the request budget that would kill every stream at
// 15s.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	urlpkg "net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

const (
	// execShellCommand is the shell pick for the terminal bridge: prefer
	// bash, fall back to whatever POSIX shell the image ships.
	execShellCommand = "exec /bin/bash 2>/dev/null || exec /bin/sh"

	// wsPingInterval is how often the server pings browser websockets;
	// clients (browsers/noVNC/xterm.js) answer pong automatically.
	wsPingInterval = 10 * time.Second

	// wsWriteTimeout bounds a single websocket write or control frame so a
	// dead TCP peer cannot block the pump forever.
	wsWriteTimeout = 10 * time.Second

	// defaultIdleTimeout keeps an otherwise-silent stream alive for five
	// minutes; pong traffic resets it via the read deadline, so ping/pong
	// keepalive keeps a stream alive indefinitely.
	defaultIdleTimeout = 5 * time.Minute

	// resizeQueueSize bounds buffered resize events so a misbehaving
	// client cannot enqueue unbounded growth.
	resizeQueueSize = 16
)

// idleTimeout returns the configured idle budget for websocket streams.
// Data activity is not required to keep a stream alive — pongs reset the
// read deadline — so an idle RFB or shell stream lives until pong stops.
func idleTimeout() time.Duration {
	raw := os.Getenv("KOS_STREAM_IDLE_TIMEOUT")
	if raw == "" {
		return defaultIdleTimeout
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return defaultIdleTimeout
	}
	return d
}

// execRequestURL builds the URL for a pod exec subresource request. Both
// the websocket and SPDY executors need the same fully-qualified URL. The
// URL is assembled by hand (instead of via CoreV1().RESTClient() so it
// works with any kubernetes.Interface — including test fakes that return
// no REST client).
func execRequestURL(cfg *rest.Config, namespace, pod, container string, command []string, tty bool) (string, error) {
	// Defense in depth: handlers validate these names for a 400 already, but
	// the URL interpolates them into the API path, so re-validate here —
	// anything slipping past would otherwise corrupt the request URL.
	if !isK8sName(namespace) {
		return "", fmt.Errorf("invalid namespace %q", namespace)
	}
	if !isK8sName(pod) {
		return "", fmt.Errorf("invalid pod %q", pod)
	}
	if container != "" && !isK8sName(container) {
		return "", fmt.Errorf("invalid container %q", container)
	}

	base := strings.TrimSuffix(cfg.Host, "/")

	params := urlpkg.Values{}
	params.Set("stdin", "true")
	params.Set("stdout", "true")
	params.Set("stderr", "true")
	if tty {
		params.Set("tty", "true")
	}
	if container != "" {
		params.Set("container", container)
	}
	for _, c := range command {
		params.Add("command", c)
	}

	return fmt.Sprintf("%s/api/v1/namespaces/%s/pods/%s/exec?%s", base,
		namespace, pod, params.Encode()), nil
}

// buildExecExecutor prefers the modern websocket executor and falls back to
// SPDY against older API servers.
func buildExecExecutor(cfg *rest.Config, namespace, pod, container string, command []string, tty bool) (remotecommand.Executor, error) {
	url, err := execRequestURL(cfg, namespace, pod, container, command, tty)
	if err != nil {
		return nil, err
	}
	parsed, err := urlpkg.Parse(url)
	if err != nil {
		return nil, err
	}

	wsExec, wsErr := remotecommand.NewWebSocketExecutor(cfg, http.MethodPost, url)
	spdyExec, spdyErr := remotecommand.NewSPDYExecutor(cfg, http.MethodPost, parsed)
	if wsErr != nil && spdyErr != nil {
		return nil, spdyErr
	}
	return remotecommand.NewFallbackExecutor(wsExec, spdyExec, func(err error) bool {
		// The websocket executor only works against kubectl 1.24+ API
		// servers; any websocket handshake/upgrade failure falls back to
		// SPDY.
		return true
	})
}

// execRun executes a short command inside a container and returns its
// stdout. It is the workhorse behind xauth provisioning, app launch and
// release cleanup — everything that does not need a stream. The caller's
// context bounds the call.
func execRun(ctx context.Context, cfg *rest.Config, namespace, pod, container string, command []string, stdin []byte) (string, error) {
	if cfg == nil {
		return "", errOffline
	}

	exec, err := buildExecExecutor(cfg, namespace, pod, container, command, false)
	if err != nil {
		return "", err
	}

	var stdout, stderr bytes.Buffer
	opts := remotecommand.StreamOptions{
		Stdin:  bytes.NewReader(stdin),
		Stdout: &stdout,
		Stderr: &stderr,
	}
	if err := exec.StreamWithContext(ctx, opts); err != nil {
		// Surface any stderr the command produced so callers can log why,
		// e.g. an xauth invocation that failed inside the pod. stdout is
		// preferred over stderr: the app-launch wrapper prints the PID on
		// stdout even on partial failure.
		if stdout.Len() > 0 {
			return stdout.String(), err
		}
		return stderr.String(), err
	}
	return stdout.String(), nil
}

// terminalSizeQueue is the minimal remotecommand.TerminalSizeQueue: size
// events are pushed as parsed JSON control frames arrive; Next blocks until
// one shows up (the executor's resize watcher expects to block) and
// returns nil once the queue is closed, ending the watcher.
type terminalSizeQueue struct {
	mu     sync.Mutex
	ch     chan *remotecommand.TerminalSize
	closed bool
}

func newTerminalSizeQueue() *terminalSizeQueue {
	return &terminalSizeQueue{ch: make(chan *remotecommand.TerminalSize, resizeQueueSize)}
}

// push enqueues a size event, dropping silently when the queue is full or
// the stream already finished — a resize race at teardown must not panic.
func (q *terminalSizeQueue) push(cols, rows uint16) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	select {
	case q.ch <- &remotecommand.TerminalSize{Width: cols, Height: rows}:
	default:
	}
}

// Next blocks until a resize arrives or the queue is closed.
func (q *terminalSizeQueue) Next() *remotecommand.TerminalSize {
	q.mu.Lock()
	closed := q.closed
	ch := q.ch
	q.mu.Unlock()
	if closed {
		return nil
	}
	size, ok := <-ch
	if !ok {
		return nil
	}
	return size
}

// close terminates the resize watcher. Idempotent.
func (q *terminalSizeQueue) close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.closed = true
	close(q.ch)
}

// parseControlFrame decodes a text-frame protocol message. Binary data
// never reaches this; unknown types return (nil, nil) so the bridge keeps
// streaming even when the peer speaks a newer protocol than this server.
func parseControlFrame(data []byte) (*remotecommand.TerminalSize, error) {
	var frame struct {
		Type string `json:"type"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.Unmarshal(data, &frame); err != nil {
		return nil, err
	}
	switch frame.Type {
	case "resize":
		return &remotecommand.TerminalSize{Width: frame.Cols, Height: frame.Rows}, nil
	default:
		return nil, nil
	}
}

// wsOutbound is one pending websocket write held by the pump.
type wsOutbound struct {
	data  []byte
	isBin bool
}

// wsOutBridge adapts remotecommand's io.Writer callbacks (pod
// stdout/stderr) into frames destined for the pump writing to the browser.
type wsOutBridge struct {
	mu     sync.Mutex
	frames chan wsOutbound
	done   bool
}

// push queues a frame, giving up once the bridge is closed — otherwise a
// late stdout write from a dying exec would block forever.
func (b *wsOutBridge) push(data []byte, isBin bool) (int, error) {
	b.mu.Lock()
	done := b.done
	b.mu.Unlock()
	if done {
		return 0, io.ErrClosedPipe
	}
	select {
	case b.frames <- wsOutbound{data: data, isBin: isBin}:
		return len(data), nil
	case <-time.After(wsWriteTimeout):
		return 0, io.ErrClosedPipe
	}
}

// Write implements io.Writer for the executor's Stdout/Stderr (binary data).
func (b *wsOutBridge) Write(p []byte) (int, error) {
	return b.push(p, true)
}

// close stops accepting frames. Idempotent.
func (b *wsOutBridge) close() {
	b.mu.Lock()
	b.done = true
	b.mu.Unlock()
}

// wsInBridge turns websocket reads into an io.Reader for the executor's
// Stdin. Binary frames are pod-stdin data; text frames are control
// messages (resize) and must never reach the shell.
type wsInBridge struct {
	conn    *websocket.Conn
	sizes   *terminalSizeQueue
	pending []byte
	// onActivity runs after every successfully read data frame. The exec
	// path uses it to refresh the read deadline: only the single reader
	// (this bridge) and the websocket handlers may touch deadlines, so
	// bridging traffic is what keeps an active shell alive.
	onActivity func()

	closed chan struct{}
	once   sync.Once
}

func newWSInBridge(conn *websocket.Conn, sizes *terminalSizeQueue, onActivity func()) *wsInBridge {
	return &wsInBridge{conn: conn, sizes: sizes, onActivity: onActivity, closed: make(chan struct{})}
}

// Read blocks on the next websocket message. A browser disconnect surfaces
// as io.EOF so remotecommand stops pulling stdin; the handler separately
// cancels the stream context, so the cluster leg cannot linger either.
func (b *wsInBridge) Read(p []byte) (int, error) {
	for {
		if len(b.pending) > 0 {
			n := copy(p, b.pending)
			b.pending = b.pending[n:]
			return n, nil
		}

		mt, data, err := b.conn.ReadMessage()
		if err != nil {
			b.once.Do(func() { close(b.closed) })
			return 0, io.EOF
		}
		if b.onActivity != nil {
			b.onActivity()
		}

		switch mt {
		case websocket.BinaryMessage:
			b.pending = data
		case websocket.TextMessage:
			if size, cerr := parseControlFrame(data); cerr == nil && size != nil {
				b.sizes.push(size.Width, size.Height)
			}
		}
	}
}

// wsPump owns every websocket write so gorilla sees a single writer. It
// drains the frames channel (data and control text) and emits keepalive
// pings, exiting cleanly when the channel closes or a write fails.
//
// Handlers and read deadlines are NOT installed here: gorilla handler
// registration is unsynchronized with respect to a running pump, so the
// single owner pattern is "call installWSHandlers before starting the pump
// and let wsPump only write". Pong/ping handling keeps the read deadline
// refreshed through the handlers installed by that helper.
func wsPump(conn *websocket.Conn, frames <-chan wsOutbound, _ time.Duration) {
	ticker := time.NewTicker(wsPingInterval)
	defer ticker.Stop()

	for {
		select {
		case frame, ok := <-frames:
			if !ok {
				return
			}
			mt := websocket.BinaryMessage
			if !frame.isBin {
				mt = websocket.TextMessage
			}
			if err := conn.WriteMessage(mt, frame.data); err != nil {
				return
			}
		case <-ticker.C:
			if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(wsWriteTimeout)); err != nil {
				return
			}
		}
	}
}

// installWSHandlers registers the browser-side ping/pong handlers and sets
// the initial read deadline. It must run BEFORE the write pump starts: both
// parties touch the same connection without synchronization, so handler
// installs have a single owner (the handset that calls this before the
// first goroutine starts).
//
// onActivity, when non-nil, runs together with every deadline refresh; the
// RFB proxy uses it to also refresh the upstream TCP deadline. Callers that
// read data frames through wsInBridge pass that bridge an onActivity doing
// the same refresh, so pongs AND data both keep the stream alive.
func installWSHandlers(conn *websocket.Conn, idle time.Duration, onActivity func()) {
	refresh := func() {
		conn.SetReadDeadline(time.Now().Add(idle))
		if onActivity != nil {
			onActivity()
		}
	}
	conn.SetPongHandler(func(string) error {
		refresh()
		return nil
	})
	conn.SetPingHandler(func(payload string) error {
		if err := conn.WriteControl(websocket.PongMessage, []byte(payload), time.Now().Add(wsWriteTimeout)); err != nil {
			return err
		}
		refresh()
		return nil
	})
	conn.SetReadDeadline(time.Now().Add(idle))
}

// wsUpgrader returns the shared upgrade configuration. Origin checks mirror
// the HTTP CORS allowlist: browser origins must be explicitly allowed,
// server-to-server clients (no Origin header) keep working — the
// withCORS middleware does not police GETs, so websocket parity is
// enforced here, one level down.
func wsUpgrader() *websocket.Upgrader {
	return &websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			return origin == "" || isOriginAllowed(origin)
		},
		Error: func(w http.ResponseWriter, _ *http.Request, status int, err error) {
			// Upgrade failures happen pre-hijack, so the ordinary JSON
			// envelope stays available — keep it like every other error
			// the browser surfaces.
			writeJSON(w, status, errorResponse{Error: err.Error()})
		},
	}
}

// execControlFrame is a server→browser lifecycle message.
type execControlFrame struct {
	Type    string `json:"type"`
	Message string `json:"message,omitempty"`
}

// handleExecWS is the terminal bridge: a browser websocket wired to a TTY
// exec session inside a pod. Binary frames carry shell data both ways;
// text frames carry control JSON ({"type":"resize","cols":..,"rows":..}).
func (a *api) handleExecWS(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	namespace := query.Get("namespace")
	if namespace == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required query parameter: namespace"})
		return
	}
	pod := query.Get("pod")
	if pod == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required query parameter: pod"})
		return
	}
	container := query.Get("container")

	// Name validation mirrors the write endpoints: a 400 before the upgrade
	// — execRequestURL interpolates these into the API path, so they must
	// be well-formed names, not URL soup.
	switch {
	case !isK8sName(namespace):
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid namespace"})
		return
	case !isK8sName(pod):
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid pod"})
		return
	case container != "" && !isK8sName(container):
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid container"})
		return
	}

	// Offline is rejected before the upgrade: no cluster means nothing to
	// exec into, and the caller gets the standard error envelope.
	if a.clientset == nil || a.restConfig == nil {
		writeError(w, errOffline)
		return
	}

	conn, err := wsUpgrader().Upgrade(w, r, nil)
	if err != nil {
		return // Upgrade already wrote the failure response.
	}
	defer conn.Close()

	// Long-lived stream: escape the 15s request deadline and manage
	// liveness through read deadlines/keepalive/cancellation instead.
	ctx, cancel := context.WithCancel(context.WithoutCancel(r.Context()))
	defer cancel()

	exec, err := buildExecExecutor(a.restConfig, namespace, pod, container,
		[]string{"/bin/sh", "-c", execShellCommand}, true)
	if err != nil {
		log.Printf("exec/ws: buildExecExecutor failed: %v", err)
		a.pushControl(conn, "error", "exec unavailable")
		return
	}

	sizes := newTerminalSizeQueue()
	defer sizes.close()

	// Day one discipline: install ping/pong + the initial read deadline
	// BEFORE the pump or the executor start — they share the connection
	// with the reader without synchronization. Pongs refresh the deadline
	// via the installed handler; data frames refresh it through the stdin
	// bridge's onActivity hook, so keepalive or traffic both suffice.
	idle := idleTimeout()
	installWSHandlers(conn, idle, nil)

	bridge := &wsOutBridge{frames: make(chan wsOutbound, resizeQueueSize)}
	in := newWSInBridge(conn, sizes, func() {
		conn.SetReadDeadline(time.Now().Add(idle))
	})

	pumpDone := make(chan struct{})
	go func(frames <-chan wsOutbound) {
		defer close(pumpDone)
		wsPump(conn, frames, idle)
	}(bridge.frames)
	defer func() {
		<-pumpDone
	}()

	opts := remotecommand.StreamOptions{
		Stdin:             in,
		Stdout:            bridge,
		Stderr:            bridge,
		Tty:               true,
		TerminalSizeQueue: sizes,
	}

	execErr := make(chan error, 1)
	go func() {
		if err := exec.StreamWithContext(ctx, opts); err != nil && !isContextCanceled(err) {
			execErr <- err
			return
		}
		execErr <- nil
	}()

	var streamErr error
	select {
	case streamErr = <-execErr:
	case <-in.closed:
		// Browser went away: cancel the cluster leg and reap its outcome.
		cancel()
		streamErr = <-execErr
	}

	bridge.close()
	// The terminal control frame is queued BEFORE the channel closes so
	// the pump flushes it and then exits through the exhausted channel.
	if streamErr != nil {
		a.queueControl(bridge, "error", streamErr.Error())
	} else {
		a.queueControl(bridge, "closed", "")
	}
	close(bridge.frames)
	<-pumpDone

	// Dropping the underlying connection ends the ReadMessage loop inside
	// the executor (defers above).
}

// queueControl enqueues the final lifecycle control frame. It bypasses the
// closed guard on purpose: bridge.close() already ran, so push() would
// reject the frame — which is exactly what must be flushed last (the pump
// drains it before exiting on the closed channel). When the channel is
// full, the OLDEST binary frame is evicted to make room: losing one
// buffered stdout chunk beats the browser never learning the shell exited.
func (a *api) queueControl(bridge *wsOutBridge, kind, message string) {
	payload, _ := json.Marshal(execControlFrame{Type: kind, Message: message})
	select {
	case bridge.frames <- wsOutbound{data: payload, isBin: false}:
		return
	default:
		select {
		case <-bridge.frames:
		default:
		}
		select {
		case bridge.frames <- wsOutbound{data: payload, isBin: false}:
		default:
		}
	}
}

// pushControl writes a control frame directly (failure paths only, where
// the pump was never started).
func (a *api) pushControl(conn *websocket.Conn, kind, message string) {
	payload, _ := json.Marshal(execControlFrame{Type: kind, Message: message})
	_ = conn.WriteControl(websocket.TextMessage, payload, time.Now().Add(wsWriteTimeout))
}

// isContextCanceled reports whether err is a context cancellation rather
// than a real stream failure.
func isContextCanceled(err error) bool {
	return err == context.Canceled || strings.Contains(err.Error(), "context canceled")
}
