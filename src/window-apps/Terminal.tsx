import { useEffect, useRef, useState, type ReactElement } from 'react';
import { connectExecStream, execWsPath, streamErrorMessage } from '../cluster/streams';
import type { ExecHandle } from '../cluster/streams';
import { Icon } from '../components/ui';
import { stringProp } from './appProps';
import type { WindowAppProps } from './types';
import '@xterm/xterm/css/xterm.css';
import './terminal.css';

// Type-only imports: the runtime chunk is loaded lazily below.
import type { ITerminalOptions, Terminal as XtermTerminal } from '@xterm/xterm';
import type { FitAddon as XtermFitAddon } from '@xterm/addon-fit';

const MISSING_SESSION_SETUP = 'No pod selected — open a terminal from Cluster Explorer.';

function cssVariable(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value !== '' ? value : fallback;
}

/**
 * Dark terminal palette. Background/cursor ride the design tokens (those are
 * theme-consistent dark colors), while the foreground is a fixed value because
 * `--kos-window-fg` flips dark on light themes (macos/gnome/kde) and a bright
 * terminal on a dark host would become unreadable.
 */
function terminalTheme(): ITerminalOptions['theme'] {
  return {
    background: cssVariable('--kos-desktop-bg', '#101418'),
    foreground: '#d4d4d4',
    cursor: cssVariable('--kos-accent', '#0078d7'),
    cursorAccent: cssVariable('--kos-accent-fg', '#ffffff'),
    selectionBackground: 'rgba(0, 120, 213, 0.45)',
  };
}

type OverlayState =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'error'; message: string; hintRetry: boolean };

export interface TerminalAppProps {
  readonly namespace: string;
  readonly pod: string;
  readonly container?: string;
}

/**
 * `kubectl exec` shell inside xterm.js, riding the binary/text exec websocket.
 * The xterm chunk is imported lazily (~200 KB), so listing Terminal in the
 * registry stays cheap.
 */
export function Terminal({ props }: WindowAppProps): ReactElement {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const fitRef = useRef<XtermFitAddon | null>(null);
  const [overlay, setOverlay] = useState<OverlayState>({ kind: 'connecting' });
  const [retryNonce, setRetryNonce] = useState(0);

  const namespace = stringProp(props, 'namespace') ?? '';
  const pod = stringProp(props, 'pod') ?? '';
  const container = stringProp(props, 'container');
  const configured = namespace !== '' && pod !== '';

  useEffect(() => {
    if (!host || !configured) {
      setOverlay({ kind: 'error', message: MISSING_SESSION_SETUP, hintRetry: false });
      return;
    }

    let cancelled = false;
    let term: XtermTerminal | null = null;
    let handle: ExecHandle | null = null;
    let resizeObserver: ResizeObserver | null = null;
    setOverlay({ kind: 'connecting' });

    const refit = (): void => {
      // Skipped while the pane has no space (minimize keeps the DOM but the
      // client area collapses to zero with display:none).
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fitRef.current?.fit();
    };

    void (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);
        if (cancelled || host === null) return;

        const fit = new FitAddon();
        fitRef.current = fit;
        term = new Terminal({
          theme: terminalTheme(),
          fontFamily: "ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace",
          fontSize: 13,
          scrollback: 5000,
          cursorBlink: true,
        } satisfies ITerminalOptions);
        term.loadAddon(fit);
        term.open(host);

        handle = connectExecStream(execWsPath(namespace, pod, container), {
          onData: (data) => {
            if (term === null) return;
            term.write(data);
          },
          onError: (message) => {
            if (!cancelled) setOverlay({ kind: 'error', message, hintRetry: true });
          },
          onClosed: () => {
            if (!cancelled) setOverlay({ kind: 'error', message: '', hintRetry: true });
          },
        });
        term.onData((data) => handle?.write(data));
        term.onResize(({ cols, rows }) => handle?.resize(cols, rows));

        // Browsers ship ResizeObserver; guard so the component also renders
        // in environments without it (unit DOM, older bridges).
        if (typeof ResizeObserver === 'function') {
          resizeObserver = new ResizeObserver(refit);
          resizeObserver.observe(host);
        }

        try {
          fit.fit();
        } catch {
          // First fit can fail on zero-sized panes; the observer retries.
        }
        handle.resize(term.cols, term.rows);
        term.focus();

        if (!cancelled) setOverlay({ kind: 'connected' });
      } catch (err: unknown) {
        if (!cancelled) {
          setOverlay({ kind: 'error', message: streamErrorMessage(err), hintRetry: true });
        }
      }
    })();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      fitRef.current = null;
      term?.dispose();
      term = null;
      handle?.close();
      handle = null;
    };
    // All inputs are primitive prop snapshots; the xterm refs live in locals.
  }, [host, configured, namespace, pod, container, retryNonce]);

  const statusElement =
    overlay.kind === 'connected' ? null : (
      <div className="kos-terminal__status" data-kind={overlay.kind} role="status">
        <span className="kos-terminal__status-icon">
          <Icon name={overlay.kind === 'error' ? 'x-circle' : 'terminal'} size={24} />
        </span>
        <span>
          {overlay.kind === 'connecting'
            ? `Connecting to ${pod}…`
            : overlay.message === ''
              ? 'The shell session closed.'
              : overlay.message}
        </span>
        {overlay.kind === 'error' && overlay.hintRetry && configured ? (
          <button
            type="button"
            className="kos-terminal__retry"
            onClick={() => setRetryNonce((value) => value + 1)}
          >
            <Icon name="refresh" size={14} />
            <span>Retry</span>
          </button>
        ) : null}
      </div>
    );

  return (
    <div className="kos-terminal">
      <div className="kos-terminal__host" ref={setHost} />
      {statusElement}
    </div>
  );
}
