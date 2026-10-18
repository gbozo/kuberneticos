import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  connectRfbStream,
  openXDisplaySession,
  releaseXDisplaySession,
  streamErrorMessage,
} from '../cluster/streams';
import type { RfbHandle } from '../cluster/streams';
import { Icon } from '../components/ui';
import { commandFromAnnotation, stringListProp, stringProp } from './appProps';
import type { WindowAppProps } from './types';
import './xdesktop.css';

export interface XDesktopAppProps {
  readonly namespace: string;
  readonly pod: string;
  readonly container?: string;
  readonly command: readonly string[];
  readonly app?: string;
  /** Descriptive label (typically `<pod>/<app>`) used in overlays. */
  readonly title?: string;
}

function parseXDesktopProps(props: Record<string, unknown>): XDesktopAppProps {
  const command =
    stringListProp(props, 'command') ?? commandFromAnnotation(stringProp(props, 'command') ?? '');
  return {
    namespace: stringProp(props, 'namespace') ?? '',
    pod: stringProp(props, 'pod') ?? '',
    container: stringProp(props, 'container'),
    command,
    app: stringProp(props, 'app'),
    title: stringProp(props, 'title'),
  };
}

type OverlayState =
  | { kind: 'connecting' }
  | { kind: 'connected'; display: number }
  | { kind: 'error'; message: string; hintRetry: boolean };

const MISSING_SESSION_SETUP = 'No pod or app command — open a remote app from Cluster Explorer.';

/**
 * Remote GUI session (noVNC canvas) for one pod app. The session lives for as
 * long as this component is mounted: minimize keeps it alive (keepAlive
 * window-app), closing the window releases it (RFB disconnect + DELETE).
 */
export function XDesktop({ props }: WindowAppProps): ReactElement {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [overlay, setOverlay] = useState<OverlayState>({ kind: 'connecting' });
  const [retryNonce, setRetryNonce] = useState(0);

  const app = useMemo(() => parseXDesktopProps(props), [props]);
  const commandKey = useMemo(() => app.command.join(' '), [app.command]);
  const configured = app.namespace !== '' && app.pod !== '' && commandKey !== '';

  useEffect(() => {
    if (!container || !configured) {
      setOverlay({ kind: 'error', message: MISSING_SESSION_SETUP, hintRetry: false });
      return;
    }

    let cancelled = false;
    let rfb: RfbHandle | null = null;
    let released = false;
    let resizeObserver: ResizeObserver | null = null;
    setOverlay({ kind: 'connecting' });

    // Race-safe release: both the cancel path (session open raced with a
    // remount) and the cleanup path may run — exactly one DELETE fires.
    const releaseOnce = (token: string): void => {
      if (released) return;
      released = true;
      void releaseXDisplaySession(token).catch(() => undefined);
    };

    const sessionPromise = openXDisplaySession({
      namespace: app.namespace,
      pod: app.pod,
      container: app.container,
      app: app.app,
      command: app.command,
    });

    void sessionPromise
      .then((session) => {
        if (cancelled) {
          releaseOnce(session.token);
          return;
        }
        rfb = connectRfbStream(session.wsPath, container, {
          onStatus: (status) => {
            if (cancelled) return;
            if (status === 'connected') {
              setOverlay({ kind: 'connected', display: session.display });
            } else if (status === 'disconnected') {
              setOverlay({ kind: 'error', message: '', hintRetry: true });
            }
          },
          onError: (message) => {
            if (cancelled) return;
            setOverlay({ kind: 'error', message, hintRetry: true });
          },
        });

        // Browsers ship ResizeObserver; guard so the component also renders
        // in environments without it (unit DOM, older bridges). Mirrors
        // Terminal.tsx: the container collapses to zero while the window is
        // minimized (display:none), so on restore the observer re-runs
        // scaleViewport against the relaid-out pane.
        if (typeof ResizeObserver === 'function') {
          resizeObserver = new ResizeObserver(() => {
            if (cancelled) return;
            rfb?.rescale();
          });
          resizeObserver.observe(container);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setOverlay({ kind: 'error', message: streamErrorMessage(err), hintRetry: true });
      });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      rfb?.disconnect();
      rfb = null;
      void sessionPromise.then(
        (session) => {
          if (cancelled) {
            releaseOnce(session.token);
          }
        },
        () => undefined,
      );
    };
    // `configured` mirrors the primitives; `app` is memoized on `props` so the
    // command identity is stable across re-renders.
  }, [container, configured, app, commandKey, retryNonce]);

  const label = app.title ?? app.pod;
  const statusElement =
    overlay.kind === 'connected' ? null : (
      <div className="kos-xdesktop__status" data-kind={overlay.kind} role="status">
        <span className="kos-xdesktop__status-icon">
          <Icon name={overlay.kind === 'error' ? 'x-circle' : 'connect'} size={24} />
        </span>
        <span>
          {overlay.kind === 'connecting'
            ? `Connecting to ${label}…`
            : overlay.message === ''
              ? 'The remote session closed.'
              : overlay.message}
        </span>
        {overlay.kind === 'error' && overlay.hintRetry && configured ? (
          <button
            type="button"
            className="kos-xdesktop__retry"
            onClick={() => setRetryNonce((value) => value + 1)}
          >
            <Icon name="refresh" size={14} />
            <span>Retry</span>
          </button>
        ) : null}
      </div>
    );

  return (
    <div className="kos-xdesktop" ref={setContainer}>
      {statusElement}
      {overlay.kind === 'connected' ? (
        <div className="kos-xdesktop__display" title="X display">
          {`:${overlay.display}`}
        </div>
      ) : null}
    </div>
  );
}
