import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectExecStream,
  connectRfbStream,
  execWsPath,
  isStreamError,
  listXDisplays,
  openXDisplaySession,
  releaseXDisplaySession,
  StreamError,
  wsUrlFor,
} from './streams';

type FetchMock = ReturnType<
  typeof vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>
>;

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

function errorResponse(status: number, statusText: string, body: unknown): Response {
  return {
    ok: false,
    status,
    statusText,
    json: async () => body,
  } as Response;
}

function stubFetch(payload: unknown): FetchMock {
  const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
  fetchMock.mockResolvedValue(jsonResponse(payload));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestedUrl(fetchMock: FetchMock): URL {
  return new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost');
}

const sessionEnvelope = {
  source: 'go',
  display: 21,
  token: 'tok-1',
  wsPath: '/api/xdisplay/ws?token=tok-1',
};

describe('X display session API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the session body to /api/xdisplay and unwraps the envelope', async () => {
    const fetchMock = stubFetch(sessionEnvelope);

    const session = await openXDisplaySession({
      namespace: 'team-a',
      pod: 'app-1',
      container: 'web',
      app: 'firefox',
      command: ['firefox', '--private-window'],
    });

    expect(session).toEqual({
      display: 21,
      token: 'tok-1',
      wsPath: '/api/xdisplay/ws?token=tok-1',
    });
    expect(requestedUrl(fetchMock).pathname).toBe('/api/xdisplay');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      namespace: 'team-a',
      pod: 'app-1',
      container: 'web',
      app: 'firefox',
      command: ['firefox', '--private-window'],
    });
  });

  it('omits the container and app fields when not provided', async () => {
    const fetchMock = stubFetch(sessionEnvelope);

    await openXDisplaySession({ namespace: 'team-a', pod: 'app-1', command: ['firefox'] });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect('container' in body).toBe(false);
    expect('app' in body).toBe(false);
  });

  it('maps a 503 offline response to a StreamError with kind "unavailable"', async () => {
    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(
      errorResponse(503, 'Service Unavailable', {
        error: 'Offline: no Kubernetes cluster is configured.',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const err: unknown = await openXDisplaySession({
      namespace: 'ns',
      pod: 'p',
      command: ['xeyes'],
    }).catch((e: unknown) => e);

    expect(isStreamError(err)).toBe(true);
    const streamError = err as StreamError;
    expect(streamError.kind).toBe('unavailable');
    expect(streamError.status).toBe(503);
    expect(streamError.message).toContain('Offline');
  });

  it('maps unexpected response shapes to kind "failed"', async () => {
    stubFetch({ source: 'go' });

    await expect(
      openXDisplaySession({ namespace: 'ns', pod: 'p', command: ['xeyes'] }),
    ).rejects.toMatchObject({ kind: 'failed' });
  });

  it('releases a session with DELETE /api/xdisplay?token=', async () => {
    const fetchMock = stubFetch({ source: 'go', ok: true });

    await releaseXDisplaySession('tok-1');

    expect(`${requestedUrl(fetchMock).pathname}${requestedUrl(fetchMock).search}`).toBe(
      '/api/xdisplay?token=tok-1',
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  });

  it('fetches /api/xdisplay/list and unwraps available + displays', async () => {
    const fetchMock = stubFetch({
      source: 'go',
      available: true,
      displays: [
        {
          display: 21,
          app: 'firefox',
          pod: 'app-1',
          namespace: 'team-a',
          container: 'web',
          createdAt: '2026-10-18T00:00:00Z',
          sessionAge: 62,
        },
      ],
    });

    const result = await listXDisplays();

    expect(result.available).toBe(true);
    expect(result.displays).toEqual([
      {
        display: 21,
        app: 'firefox',
        pod: 'app-1',
        namespace: 'team-a',
        container: 'web',
        createdAt: '2026-10-18T00:00:00Z',
        // sessionAge is whole SECONDS (the server's int64 seconds field).
        sessionAge: 62,
      },
    ]);
    expect(requestedUrl(fetchMock).pathname).toBe('/api/xdisplay/list');
  });

  it('drops a non-numeric sessionAge instead of reporting a bogus value', async () => {
    stubFetch({
      source: 'go',
      available: true,
      displays: [{ display: 22, pod: 'app-1', namespace: 'team-a', sessionAge: '1m2s' }],
    });

    const result = await listXDisplays();

    expect(result.displays).toHaveLength(1);
    expect(result.displays[0].sessionAge).toBeUndefined();
  });

  it('answers available:false in offline mode without throwing', async () => {
    stubFetch({ source: 'offline', available: false, displays: [] });

    await expect(listXDisplays()).resolves.toEqual({ available: false, displays: [] });
  });

  it('propagates the offline 503 from the list endpoint', async () => {
    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(errorResponse(503, 'Service Unavailable', { error: 'offline' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listXDisplays()).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('aborts a request that exceeds the timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
      fetchMock.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const pending = openXDisplaySession({ namespace: 'ns', pod: 'p', command: ['xeyes'] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

      vi.advanceTimersByTime(15000);
      await expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// WebSocket fakes
// ---------------------------------------------------------------------------

type Listener = (event: { data?: unknown }) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readonly url: string;
  binaryType: string = 'blob';
  readyState: number = FakeWebSocket.CONNECTING;
  sent: (string | ArrayBuffer)[] = [];

  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('FakeWebSocket.send while CONNECTING');
    }
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', {});
  }

  emit(type: string, event: { data?: unknown }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', {});
  }

  serverBinary(data: ArrayBuffer): void {
    this.emit('message', { data });
  }

  serverText(raw: string): void {
    this.emit('message', { data: raw });
  }

  error(): void {
    this.emit('error', {});
  }
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error('no FakeWebSocket created');
  return socket;
}

const EXEC_PATH = '/api/exec/ws?namespace=ns&pod=p1';

describe('connectExecStream', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('connects to the ws URL for the given path', () => {
    connectExecStream(EXEC_PATH);

    const socket = lastSocket();
    expect(socket.url).toBe('ws://localhost:3000/api/exec/ws?namespace=ns&pod=p1');
    expect(socket.binaryType).toBe('arraybuffer');
  });

  it('builds the server exec path with namespace, pod and optional container', () => {
    expect(execWsPath('team-a', 'app-1')).toBe('/api/exec/ws?namespace=team-a&pod=app-1');
    expect(execWsPath('team-a', 'app-1', 'web')).toBe(
      '/api/exec/ws?namespace=team-a&pod=app-1&container=web',
    );
  });

  it('queues writes until the socket opens and sends them as binary data', () => {
    const handle = connectExecStream(EXEC_PATH);
    const socket = lastSocket();
    handle.write('ls\r\n');

    expect(socket.sent).toEqual([]);
    socket.open();
    const payload = socket.sent[0] as ArrayBuffer;
    expect(new TextDecoder().decode(payload)).toBe('ls\r\n');
  });

  it('delivers binary frames through onData and JSON control frames through handlers', () => {
    const onData = vi.fn<(data: Uint8Array) => void>();
    const onError = vi.fn<(message: string) => void>();
    const onClosed = vi.fn<() => void>();
    connectExecStream(EXEC_PATH, { onData, onError, onClosed });

    const socket = lastSocket();
    socket.open();

    socket.serverBinary(new TextEncoder().encode('stdout\n').buffer);
    expect(onData).toHaveBeenCalledTimes(1);
    expect(new TextDecoder().decode(onData.mock.calls[0][0] as Uint8Array)).toBe('stdout\n');

    socket.serverText('{"type":"error","message":"container not found"}');
    expect(onError).toHaveBeenCalledWith('container not found');

    socket.serverText('{"type":"closed"}');
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('notifies onClosed once even when the close event follows a closed message', () => {
    const onClosed = vi.fn<() => void>();
    connectExecStream(EXEC_PATH, { onClosed });

    const socket = lastSocket();
    socket.open();
    socket.serverText('{"type":"closed"}');
    socket.close();

    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('sends resize as a text JSON frame', () => {
    const handle = connectExecStream(EXEC_PATH);
    const socket = lastSocket();
    socket.open();

    handle.resize(120, 40);

    expect(socket.sent).toEqual([JSON.stringify({ type: 'resize', cols: 120, rows: 40 })]);
  });

  it('surfaces socket errors via onError and stays silent after close', () => {
    const onError = vi.fn<(message: string) => void>();
    const onClosed = vi.fn<() => void>();
    const handle = connectExecStream(EXEC_PATH, { onError, onClosed });
    const socket = lastSocket();
    socket.open();

    socket.error();
    expect(onError).toHaveBeenCalledWith('The terminal connection failed.');

    handle.close();
    socket.error();
    socket.close();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('ignores non-control text frames and malformed JSON', () => {
    const onError = vi.fn<(message: string) => void>();
    const onClosed = vi.fn<() => void>();
    connectExecStream(EXEC_PATH, { onError, onClosed });
    const socket = lastSocket();
    socket.open();

    socket.serverText('not json');
    socket.serverText('{"type":"ping"}');
    expect(onError).not.toHaveBeenCalled();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('still delivers frames that arrive as Blobs', async () => {
    const onData = vi.fn<(data: Uint8Array) => void>();
    connectExecStream(EXEC_PATH, { onData });
    const socket = lastSocket();
    socket.open();

    socket.emit('message', { data: new Blob([new TextEncoder().encode('chunk\n')]) });

    await vi.waitFor(() => {
      expect(onData).toHaveBeenCalledTimes(1);
      expect(new TextDecoder().decode(onData.mock.calls[0][0] as Uint8Array)).toBe('chunk\n');
    });
  });
});

// ---------------------------------------------------------------------------
// connectRfbStream — RFB is mocked at module level
// ---------------------------------------------------------------------------

interface FakeRfbInstance {
  target: HTMLElement;
  url: string;
  scaleViewport: boolean;
  disconnectCalls: number;
  emit(type: string, event: { detail?: unknown }): void;
}

let rfbInstances: FakeRfbInstance[] = [];

vi.mock('@novnc/novnc', () => {
  class FakeRfb {
    target: HTMLElement;
    url: string;
    scaleViewport = false;
    resizeSession = false;
    viewOnly = false;
    disconnectCalls = 0;
    private listeners = new Map<string, Set<(event: { detail?: unknown }) => void>>();

    constructor(target: HTMLElement, url: string) {
      this.target = target;
      this.url = url;
      rfbInstances.push(this);
    }

    addEventListener(type: string, listener: (event: { detail?: unknown }) => void): void {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)?.add(listener);
    }

    emit(type: string, event: { detail?: unknown }): void {
      for (const listener of [...(this.listeners.get(type) ?? [])]) {
        listener(event);
      }
    }

    disconnect(): void {
      this.disconnectCalls += 1;
    }
  }
  return { default: FakeRfb };
});

describe('connectRfbStream', () => {
  beforeEach(() => {
    rfbInstances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates an RFB session on a ws URL targeting the given element and scales it', () => {
    const target = document.createElement('div');
    connectRfbStream('/api/xdisplay/ws?token=tok-1', target);

    expect(rfbInstances).toHaveLength(1);
    const rfb = rfbInstances[0];
    expect(rfb.target).toBe(target);
    expect(rfb.url).toBe('ws://localhost:3000/api/xdisplay/ws?token=tok-1');
    expect(rfb.scaleViewport).toBe(true);
  });

  it('maps connect/disconnect/clipboard events and stops reporting after release', () => {
    const target = document.createElement('div');
    const onStatus = vi.fn<(status: string) => void>();
    const onError = vi.fn<(message: string) => void>();
    const onClipboard = vi.fn<(text: string) => void>();
    const handle = connectRfbStream('/api/xdisplay/ws?token=tok-1', target, {
      onStatus,
      onError,
      onClipboard,
    });
    const rfb = rfbInstances[0];

    rfb.emit('connect', {});
    expect(onStatus).toHaveBeenCalledWith('connected');

    rfb.emit('disconnect', { detail: { clean: true } });
    expect(onStatus).toHaveBeenCalledWith('disconnected');
    expect(onError).not.toHaveBeenCalled();

    rfb.emit('clipboard', { detail: { text: 'clipboard' } });
    expect(onClipboard).toHaveBeenCalledWith('clipboard');

    onStatus.mockClear();
    onError.mockClear();
    handle.disconnect();
    expect(rfb.disconnectCalls).toBe(1);

    rfb.emit('disconnect', { detail: { clean: false } });
    rfb.emit('credentialsrequired', { detail: { types: ['password'] } });
    expect(onStatus).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('surfaces a dirty disconnect and a security failure as errors', () => {
    const target = document.createElement('div');
    const onError = vi.fn<(message: string) => void>();
    connectRfbStream('/api/xdisplay/ws?token=tok-1', target, { onError });
    const rfb = rfbInstances[0];

    rfb.emit('disconnect', { detail: { clean: false } });
    expect(onError).toHaveBeenCalledWith('The remote session closed unexpectedly.');

    rfb.emit('securityfailure', { detail: { status: 3, reason: 'bad cookie' } });
    expect(onError).toHaveBeenCalledWith('bad cookie');

    rfb.emit('credentialsrequired', { detail: { types: ['password'] } });
    expect(rfb.disconnectCalls).toBe(1);
  });

  it('falls back to the generic security failure message when no reason is given', () => {
    const target = document.createElement('div');
    const onError = vi.fn<(message: string) => void>();
    connectRfbStream('/api/xdisplay/ws?token=tok-1', target, { onError });
    rfbInstances[0].emit('securityfailure', { detail: { status: 3 } });
    expect(onError).toHaveBeenCalledWith('The session failed the security handshake.');
  });

  it('rescale() re-asserts scaleViewport so a relaid-out pane rescales', () => {
    const target = document.createElement('div');
    const handle = connectRfbStream('/api/xdisplay/ws?token=tok-1', target);
    const rfb = rfbInstances[0];

    rfb.scaleViewport = false;
    handle.rescale();
    expect(rfb.scaleViewport).toBe(true);
  });

  it('resolves absolute ws URLs from the current origin', () => {
    expect(wsUrlFor('/api/exec/ws?a=1')).toBe('ws://localhost:3000/api/exec/ws?a=1');
  });
});
