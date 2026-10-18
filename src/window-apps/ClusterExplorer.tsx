import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { clusterClient } from '../cluster/client';
import type { ClusterInfo, PodInfo } from '../cluster/client';
import type { Dispatch } from 'react';
import { Icon } from '../components/ui';
import { useDesktop } from '../state/DesktopContext';
import type { DesktopAction } from '../state/types';
import { commandFromAnnotation } from './appProps';

// Pods carrying this annotation expose a launchable GUI command (single argv or
// space-separated): Open GUI app dispatches an XDesktop session for it.
const XAPP_ANNOTATION = 'kos.dev/x-app';

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; clusters: readonly ClusterInfo[]; pods: readonly PodInfo[] }
  | { status: 'error' };

const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const listStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const podRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const podLabelStyle: CSSProperties = {
  display: 'flex',
  flex: 1,
  minWidth: 0,
  flexDirection: 'column',
  overflow: 'hidden',
};

const podMetaStyle: CSSProperties = {
  color: 'var(--kos-muted)',
  fontSize: 12,
};

const actionButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '3px 8px',
  border: '1px solid var(--kos-input-border)',
  borderRadius: 2,
  background: 'var(--kos-input-bg)',
  color: 'inherit',
  font: 'inherit',
  fontSize: 12,
  cursor: 'pointer',
};

// PodInfo (src/cluster/client.ts) carries no per-pod container names, so
// openTerminal/openGuiApp do not pass `container` to the window props; the
// server then execs the pod's first (main) container. Extend PodInfo list
// payloads first if per-container targeting is ever needed.
function openTerminal(dispatch: Dispatch<DesktopAction>, pod: PodInfo): void {
  dispatch({
    type: 'ADD_WINDOW',
    input: {
      appId: 'Terminal',
      title: `Terminal — ${pod.name}`,
      width: 720,
      height: 440,
      props: { namespace: pod.namespace, pod: pod.name },
    },
  });
}

function xAppCommand(pod: PodInfo): readonly string[] {
  const annotation = pod.annotations?.[XAPP_ANNOTATION];
  if (annotation === undefined || annotation.trim() === '') return [];
  return commandFromAnnotation(annotation);
}

function openGuiApp(
  dispatch: Dispatch<DesktopAction>,
  pod: PodInfo,
  command: readonly string[],
): void {
  const title = `${pod.name}/${command[0]}`;
  dispatch({
    type: 'ADD_WINDOW',
    input: {
      appId: 'XDesktop',
      title,
      width: 900,
      height: 600,
      props: {
        namespace: pod.namespace,
        pod: pod.name,
        command: [...command],
        title,
      },
    },
  });
}

function PodRow({
  pod,
  dispatch,
}: {
  pod: PodInfo;
  dispatch: Dispatch<DesktopAction>;
}): ReactElement {
  const command = xAppCommand(pod);
  const hasGuiApp = command.length > 0;

  return (
    <li>
      <div style={podRowStyle}>
        <div style={podLabelStyle}>
          <span>{pod.name}</span>
          <span style={podMetaStyle}>
            {pod.namespace}
            {pod.phase === '' ? '' : ` — ${pod.phase}`}
            {hasGuiApp ? ` — app: ${command.join(' ')}` : ''}
          </span>
        </div>
        <button
          type="button"
          style={actionButtonStyle}
          title="Open a shell in this pod"
          onClick={() => openTerminal(dispatch, pod)}
        >
          <Icon name="terminal" size={14} />
          <span>Open terminal</span>
        </button>
        <button
          type="button"
          style={actionButtonStyle}
          disabled={!hasGuiApp}
          title={
            hasGuiApp
              ? `Launch ${command.join(' ')} on a kos-xserver display`
              : `Set the ${XAPP_ANNOTATION} annotation to enable a GUI app`
          }
          onClick={() => {
            if (hasGuiApp) openGuiApp(dispatch, pod, command);
          }}
        >
          <Icon name="box" size={14} />
          <span>Open GUI app…</span>
        </button>
      </div>
    </li>
  );
}

const emptyPods: readonly PodInfo[] = [];

export function ClusterExplorer(): ReactElement {
  const { dispatch } = useDesktop();
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    clusterClient
      .listClusters()
      .then(async (clusters) => {
        if (!active) return null;
        const cluster = clusters[0];
        if (cluster === undefined) {
          return { clusters, pods: emptyPods };
        }
        return { clusters, pods: await clusterClient.listPods(cluster.id) };
      })
      .then((data) => {
        if (active && data !== null) setState({ status: 'loaded', ...data });
      })
      .catch(() => {
        if (active) setState({ status: 'error' });
      });
    return () => {
      active = false;
    };
  }, []);

  if (state.status === 'loading') {
    return <div style={containerStyle}>Loading clusters…</div>;
  }

  if (state.status === 'error') {
    return <div style={containerStyle}>No clusters configured — start the Go server</div>;
  }

  if (state.clusters.length === 0) {
    return <div style={containerStyle}>No clusters configured — start the Go server</div>;
  }

  return (
    <div style={containerStyle}>
      <ul style={listStyle}>
        {state.clusters.map((cluster) => (
          <li key={cluster.id}>
            {cluster.name} — {cluster.server}
          </li>
        ))}
      </ul>
      <div>
        <h3 style={{ margin: '8px 0 4px', fontSize: 13 }}>Pods</h3>
        {state.pods.length === 0 ? (
          <div style={podMetaStyle}>No pods</div>
        ) : (
          <ul style={listStyle}>
            {state.pods.map((pod) => (
              <PodRow key={pod.name} pod={pod} dispatch={dispatch} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
