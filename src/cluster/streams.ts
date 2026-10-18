import RFB from '@novnc/novnc';
import { REQUEST_TIMEOUT_MS } from './client';

// Typed error surfaced by every streams entry point. `kind` distinguishes the
// request modes consumers must handle:
// - 'unavailable': the server answered 503 — no cluster, or the xserver/exec
//   transport is not usable (offline / pool exhausted).
// - 'timeout': the request ran past the Cluster API budget.
// - 'network': `fetch` itself failed (server down, proxy refused).
// - 'failed': any other HTTP status or malformed response payload.
export type StreamErrorKind = 'unavailable' | 'timeout' | 'network' | 'failed';

// Same base path `HttpClusterClient` uses; both go through the Vite-proxied /api.
const API_BASE = '/api';

export class StreamError extends Error {
  readonly kind: StreamErrorKind;
  readonly status?: number;

  constructor(kind: StreamErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'StreamError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export function isStreamError(err: unknown): err is StreamError {
  return err instanceof StreamError;
}

/** Short message for status overlays: `StreamError` keeps its detail, anything else stringifies. */
export function streamErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function timeoutError(url: string): StreamError {
  return new StreamError(
    'timeout',
    `Stream API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s (${url})`,
  );
}

async function failureFrom(response: Response, url: string): Promise<StreamError> {
  let detail = '';
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const value = (body as { error: unknown }).error;
      if (typeof value === 'string') detail = value;
    }
  } catch {
    // Non-JSON body (proxy error page, empty body, …) — fall back to the status line.
  }
  const kind: StreamErrorKind = response.status === 503 ? 'unavailable' : 'failed';
  return new StreamError(
    kind,
    `Stream API request failed: ${response.status} ${response.statusText} (${url})${detail === '' ? '' : `: ${detail}`}`,
    response.status,
  );
}

interface PendingRequest {
  readonly response: Response;
  /** Releases the request timeout; must be called once the body has been consumed. */
  readonly done: () => void;
  readonly isAborted: () => boolean;
}

/**
 * `fetch` with the same request timeout discipline as `client.ts`: aborts after
 * `REQUEST_TIMEOUT_MS` and converts the abort into a clear error. Calls the
 * global `fetch` directly (no captured reference) so global stubs keep working.
 */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<PendingRequest> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw timeoutError(url);
    }
    throw err instanceof Error
      ? new StreamError('network', `Stream API request failed (${url}): ${err.message}`)
      : new StreamError('network', `Stream API request failed (${url})`);
  }
  return {
    response,
    // The timer deliberately stays armed after `fetch` settles so the timeout also
    // covers the body read. Call `done()` once the response has been consumed.
    done: () => clearTimeout(timer),
    isAborted: () => controller.signal.aborted,
  };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const { response, done, isAborted } = await fetchWithTimeout(url, init);
  try {
    if (!response.ok) {
      throw await failureFrom(response, url);
    }
    return (await response.json()) as T;
  } catch (err) {
    if (isAborted()) throw timeoutError(url);
    throw err;
  } finally {
    done();
  }
}

async function requestAction(url: string, method: 'DELETE'): Promise<void> {
  const { response, done, isAborted } = await fetchWithTimeout(url, { method });
  try {
    if (!response.ok) {
      throw await failureFrom(response, url);
    }
  } catch (err) {
    if (isAborted()) throw timeoutError(url);
    throw err;
  } finally {
    done();
  }
}

// ---------------------------------------------------------------------------
// X display sessions (central shared X server pod)
// ---------------------------------------------------------------------------

/** Payload for `openXDisplaySession` — mirrors the server's POST /api/xdisplay body. */
export interface XDisplaySessionRequest {
  readonly namespace: string;
  readonly pod: string;
  readonly container?: string;
  /** argv of the app to launch inside the pod. */
  readonly command: readonly string[];
  /** Human-readable app name recorded server-side (defaults to `command[0]`). */
  readonly app?: string;
}

/** Success value of `openXDisplaySession` — mirrors the server response body. */
export interface XDisplaySession {
  readonly display: number;
  readonly token: string;
  readonly wsPath: string;
}

interface XDisplaySessionEnvelope {
  readonly display: number;
  readonly token: string;
  readonly wsPath: string;
}

function isSessionEnvelope(value: unknown): value is XDisplaySessionEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.display === 'number' &&
    Number.isInteger(record.display) &&
    typeof record.token === 'string' &&
    record.token !== '' &&
    typeof record.wsPath === 'string' &&
    record.wsPath !== ''
  );
}

/** Allocates a display, launches the command in the pod and returns the RFB socket path. */
export async function openXDisplaySession(
  params: XDisplaySessionRequest,
): Promise<XDisplaySession> {
  const body: Record<string, unknown> = {
    namespace: params.namespace,
    pod: params.pod,
    command: [...params.command],
  };
  if (params.container !== undefined) body.container = params.container;
  if (params.app !== undefined) body.app = params.app;
  const envelope = await requestJson<unknown>(`${API_BASE}/xdisplay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!isSessionEnvelope(envelope)) {
    throw new StreamError('failed', 'Unexpected /api/xdisplay response shape');
  }
  return { display: envelope.display, token: envelope.token, wsPath: envelope.wsPath };
}

/** Kills the launched app process and frees the display. Fire-and-forget on close. */
export async function releaseXDisplaySession(token: string): Promise<void> {
  const params = new URLSearchParams({ token });
  await requestAction(`${API_BASE}/xdisplay?${params.toString()}`, 'DELETE');
}

/** One entry of GET /api/xdisplay/list. */
export interface XDisplayListItem {
  readonly display: number;
  readonly app?: string;
  readonly pod: string;
  readonly namespace: string;
  readonly container?: string;
  readonly createdAt?: string;
  /** Seconds since session creation, as sent by the server (number). */
  readonly sessionAge?: number;
}

/** Result of GET /api/xdisplay/list — `available:false` in offline mode. */
export interface XDisplayListResult {
  readonly available: boolean;
  readonly displays: readonly XDisplayListItem[];
}

export async function listXDisplays(): Promise<XDisplayListResult> {
  const envelope = await requestJson<unknown>(`${API_BASE}/xdisplay/list`);
  if (typeof envelope !== 'object' || envelope === null) {
    throw new StreamError('failed', 'Unexpected /api/xdisplay/list response shape');
  }
  const record = envelope as { available?: unknown; displays?: unknown };
  if (typeof record.available !== 'boolean' || !Array.isArray(record.displays)) {
    throw new StreamError('failed', 'Unexpected /api/xdisplay/list response shape');
  }
  const displays: XDisplayListItem[] = [];
  for (const entry of record.displays) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.display !== 'number' || typeof item.pod !== 'string') continue;
    displays.push({
      display: item.display,
      app: optionalString(item.app),
      pod: item.pod,
      namespace: typeof item.namespace === 'string' ? item.namespace : '',
      container: optionalString(item.container),
      createdAt: optionalString(item.createdAt),
      sessionAge: optionalNumber(item.sessionAge),
    });
  }
  return { available: record.available, displays };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Whole-number field guard: the server reports `sessionAge` in seconds. */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// WebSocket transport (RFB for GUI apps, exec frames for terminals)
// ---------------------------------------------------------------------------

/** Builds an absolute `ws(s)://` URL for a server-provided path. */
export function wsUrlFor(wsPath: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}${wsPath}`;
}

/** Builds the terminal exec socket path the server exposes. */
export function execWsPath(namespace: string, pod: string, container?: string): string {
  const params = new URLSearchParams({ namespace, pod });
  if (container !== undefined && container !== '') params.set('container', container);
  return `/api/exec/ws?${params.toString()}`;
}

export type RfbStatus = 'connecting' | 'connected' | 'disconnected';

export interface RfbHandlers {
  onStatus?(status: RfbStatus): void;
  onError?(message: string): void;
  /** Text-only clipboard payload received from the remote session. */
  onClipboard?(text: string): void;
}

export interface RfbHandle {
  disconnect(): void;
  /**
   * Recomputes the scaled viewport from the target element's current size.
   * Needed when the pane relays out while hidden (minimize collapses the
   * container to zero via display:none) and after restore — noVNC inserts
   * an unscaled/scaled canvas and must be nudged to rescale.
   */
  rescale(): void;
}

/**
 * Connects a noVNC RFB session to the server-provided RFB websocket path.
 *
 * No password is supplied: the per-display xauth cookie handles authentication
 * server-side. Scaling strategy: RFB `scaleViewport` — noVNC rescales the
 * framebuffer to the target element's client area, which covers window
 * resize/maximize without re-requesting a remote resize.
 */
export function connectRfbStream(
  wsPath: string,
  target: HTMLElement,
  handlers: RfbHandlers = {},
): RfbHandle {
  const socket = new RFB(target, wsUrlFor(wsPath));
  socket.scaleViewport = true;

  let released = false;

  socket.addEventListener('connect', () => {
    if (released) return;
    handlers.onStatus?.('connected');
  });
  socket.addEventListener('disconnect', (event) => {
    if (released) return;
    handlers.onStatus?.('disconnected');
    if (!event.detail.clean) {
      handlers.onError?.('The remote session closed unexpectedly.');
    }
  });
  socket.addEventListener('securityfailure', (event) => {
    if (released) return;
    const reason = event.detail.reason;
    handlers.onError?.(reason ?? 'The session failed the security handshake.');
  });
  socket.addEventListener('credentialsrequired', () => {
    if (released) return;
    handlers.onError?.(
      'The session requested credentials — the per-display xauth cookie did not provision.',
    );
    socket.disconnect();
  });
  socket.addEventListener('clipboard', (event) => {
    if (released) return;
    handlers.onClipboard?.(event.detail.text);
  });

  return {
    disconnect(): void {
      if (released) return;
      released = true;
      socket.disconnect();
    },
    rescale(): void {
      if (released) return;
      // Re-asserting the (already true) flag makes noVNC recompute the
      // scaled canvas from the target's current client area.
      socket.scaleViewport = true;
    },
  };
}

export interface ExecHandlers {
  /** Raw stdout/stderr bytes (binary frame). Feed straight into xterm.write. */
  onData?(data: Uint8Array): void;
  onError?(message: string): void;
  onClosed?(): void;
}

export interface ExecHandle {
  /** Sends input as a binary data frame. */
  write(data: string): void;
  /** Sends a terminal resize control frame (text). */
  resize(cols: number, rows: number): void;
  /** Closes the socket. */
  close(): void;
}

interface ExecControlMessage {
  readonly type: unknown;
  readonly message: unknown;
}

function parseExecControl(raw: string): ExecControlMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  return { type: record.type, message: record.message };
}

/**
 * Narrowing for websocket binary payloads. Realms can differ (polyfills,
 * native bridges), so `instanceof ArrayBuffer` alone is not enough; an
 * ArrayBuffer is duck-identified by a numeric `byteLength` that is not a view.
 */
function isBufferFrame(data: unknown): data is ArrayBuffer {
  return (
    data instanceof ArrayBuffer ||
    (typeof data === 'object' &&
      data !== null &&
      'byteLength' in data &&
      typeof (data as { byteLength: unknown }).byteLength === 'number' &&
      !ArrayBuffer.isView(data))
  );
}

/** Reads a Blob body via FileReader (some environments lack Blob.arrayBuffer). */
function readBlobBytes(blob: Blob, onBytes: (bytes: Uint8Array) => void): void {
  const reader = new FileReader();
  reader.onload = () => {
    const result: unknown = reader.result;
    if (!isBufferFrame(result)) return;
    onBytes(new Uint8Array(result));
  };
  reader.readAsArrayBuffer(blob);
}

/**
 * Browser WebSocket to the terminal exec bridge. Frames follow the server
 * protocol: binary = stdin/stdout data, text JSON = control
 * (`{"type":"resize"…}` outbound; `{"type":"error"|"closed"}` inbound).
 */
export function connectExecStream(wsPath: string, handlers: ExecHandlers = {}): ExecHandle {
  const socket = new WebSocket(wsUrlFor(wsPath));
  socket.binaryType = 'arraybuffer';

  const encoder = new TextEncoder();
  let released = false;
  let closedNotified = false;

  /** Text/binary chunks queued until the socket opens (send order preserved). */
  const pending: { kind: 'text' | 'binary'; value: string }[] = [];

  const notifyClosed = (): void => {
    if (closedNotified) return;
    closedNotified = true;
    handlers.onClosed?.();
  };

  socket.addEventListener('open', () => {
    if (released) return;
    for (const chunk of pending.splice(0, pending.length)) {
      sendChunk(chunk);
    }
  });

  const sendChunk = (chunk: { kind: 'text' | 'binary'; value: string }): void => {
    if (socket.readyState !== WebSocket.OPEN) {
      pending.push(chunk);
      return;
    }
    if (chunk.kind === 'binary') {
      socket.send(encoder.encode(chunk.value));
      return;
    }
    socket.send(chunk.value);
  };

  socket.addEventListener('message', (event) => {
    if (released) return;
    const data: unknown = event.data;
    if (typeof data === 'string') {
      const control = parseExecControl(data);
      if (control === null) return;
      if (control.type === 'error') {
        handlers.onError?.(
          typeof control.message === 'string' && control.message !== ''
            ? control.message
            : 'The pod reported a terminal error.',
        );
      } else if (control.type === 'closed') {
        notifyClosed();
      }
      return;
    }
    if (isBufferFrame(data)) {
      handlers.onData?.(new Uint8Array(data));
      return;
    }
    if (data instanceof Blob) {
      readBlobBytes(data, (bytes) => {
        if (!released) handlers.onData?.(bytes);
      });
    }
  });

  socket.addEventListener('error', () => {
    if (released) return;
    handlers.onError?.('The terminal connection failed.');
  });

  socket.addEventListener('close', () => {
    if (released) return;
    notifyClosed();
  });

  return {
    write(data: string): void {
      if (released) return;
      sendChunk({ kind: 'binary', value: data });
    },
    resize(cols: number, rows: number): void {
      if (released) return;
      sendChunk({ kind: 'text', value: JSON.stringify({ type: 'resize', cols, rows }) });
    },
    close(): void {
      if (released) return;
      released = true;
      pending.splice(0, pending.length);
      try {
        socket.close(1000, 'terminal closed');
      } catch {
        // Already closing/closed — nothing to do.
      }
    },
  };
}
