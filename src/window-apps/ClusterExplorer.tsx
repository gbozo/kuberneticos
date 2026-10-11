import { useEffect, useState, type CSSProperties } from 'react';
import { clusterClient } from '../cluster/client';
import type { ClusterInfo } from '../cluster/client';

type LoadState =
  | { status: 'loading' }
  | { status: 'loaded'; clusters: readonly ClusterInfo[] }
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

export function ClusterExplorer() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    clusterClient
      .listClusters()
      .then((clusters) => {
        if (active) setState({ status: 'loaded', clusters });
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
    </div>
  );
}
