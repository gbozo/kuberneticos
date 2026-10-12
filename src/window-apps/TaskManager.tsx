import { useEffect, useRef, useState, type ReactNode } from 'react';
import { clusterClient } from '../cluster/client';
import type {
  DeploymentInfo,
  NamespaceInfo,
  NodeDetailInfo,
  NodeInfo,
  PodInfo,
  ReplicaSetInfo,
  ReplicationControllerInfo,
  ServiceInfo,
} from '../cluster/client';
import { AppBarButton, AutoSuggestBox, Icon, ListView, Tooltip } from '../components/ui';
import type { WindowAppProps } from './types';
import './taskmanager.css';

type AsyncState<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; message: string };

type View =
  | { kind: 'clusters' }
  | { kind: 'cluster'; clusterId: string; section: 'nodes' | 'namespaces' }
  | { kind: 'node'; clusterId: string; nodeName: string }
  | { kind: 'namespace'; clusterId: string; namespace: string }
  | { kind: 'pod'; clusterId: string; namespace: string; podName: string };

function useLoaded<T>(key: string, load: () => Promise<T>): AsyncState<T> {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    loadRef.current().then(
      (data) => {
        if (active) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (active) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [key]);

  return state;
}

interface RowItem {
  key: string;
  title: string;
  meta?: string;
  onClick: () => void;
}

function Row({ item }: { item: RowItem }) {
  return (
    <li className="kos-taskmanager__row">
      <button type="button" className="kos-taskmanager__row-button" onClick={item.onClick}>
        <span className="kos-taskmanager__row-main">
          <span className="kos-taskmanager__row-title">{item.title}</span>
          {item.meta ? (
            <>
              {' '}
              <span className="kos-taskmanager__row-meta">{item.meta}</span>
            </>
          ) : null}
        </span>
        <Icon name="chevron-right" size={14} className="kos-taskmanager__row-chevron" />
      </button>
    </li>
  );
}

function AsyncList<T>({
  state,
  emptyText,
  toRow,
}: {
  state: AsyncState<readonly T[]>;
  emptyText: string;
  toRow: (item: T) => RowItem;
}) {
  if (state.status === 'loading') {
    return <p className="kos-taskmanager__status">Loading…</p>;
  }
  if (state.status === 'error') {
    return <p className="kos-taskmanager__status is-error">{state.message}</p>;
  }
  if (state.data.length === 0) {
    return <p className="kos-taskmanager__status">{emptyText}</p>;
  }
  return (
    <ListView>
      {state.data.map((item) => {
        const row = toRow(item);
        return <Row key={row.key} item={row} />;
      })}
    </ListView>
  );
}

function KeyValueList({ entries }: { entries: readonly (readonly [string, string])[] }) {
  if (entries.length === 0) {
    return <p className="kos-taskmanager__status">None</p>;
  }
  return (
    <dl className="kos-taskmanager__kv">
      {entries.map(([key, value]) => (
        <div className="kos-taskmanager__kv-row" key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function NodeDetailView({ clusterId, nodeName }: { clusterId: string; nodeName: string }) {
  const state = useLoaded(`node:${clusterId}:${nodeName}`, () =>
    clusterClient.getNode(clusterId, nodeName),
  );

  if (state.status === 'loading') {
    return <p className="kos-taskmanager__status">Loading node details…</p>;
  }
  if (state.status === 'error') {
    return <p className="kos-taskmanager__status is-error">{state.message}</p>;
  }

  const node = state.data as NodeDetailInfo;
  return (
    <div className="kos-taskmanager__detail">
      <section>
        <h3 className="kos-taskmanager__section-title">Overview</h3>
        <KeyValueList
          entries={[
            ['Name', node.name],
            ['Status', node.status],
            ['Roles', node.roles.join(', ')],
            ['Version', node.version],
          ]}
        />
      </section>
      <section>
        <h3 className="kos-taskmanager__section-title">Capacity</h3>
        <KeyValueList entries={Object.entries(node.capacity)} />
      </section>
      <section>
        <h3 className="kos-taskmanager__section-title">Allocatable</h3>
        <KeyValueList entries={Object.entries(node.allocatable)} />
      </section>
      <section>
        <h3 className="kos-taskmanager__section-title">Conditions</h3>
        <KeyValueList
          entries={node.conditions.map((condition) => [condition.type, condition.status])}
        />
      </section>
      <section>
        <h3 className="kos-taskmanager__section-title">Addresses</h3>
        <KeyValueList entries={node.addresses.map((address) => [address.type, address.address])} />
      </section>
    </div>
  );
}

interface NamespaceWorkloads {
  deployments: readonly DeploymentInfo[];
  replicaSets: readonly ReplicaSetInfo[];
  controllers: readonly ReplicationControllerInfo[];
  services: readonly ServiceInfo[];
  pods: readonly PodInfo[];
}

function NamespaceView({
  clusterId,
  namespace,
  onSelectPod,
}: {
  clusterId: string;
  namespace: string;
  onSelectPod: (pod: string) => void;
}) {
  const state = useLoaded(`namespace:${clusterId}:${namespace}`, () =>
    Promise.all([
      clusterClient.listDeployments(clusterId, namespace),
      clusterClient.listReplicaSets(clusterId, namespace),
      clusterClient.listReplicationControllers(clusterId, namespace),
      clusterClient.listServices(clusterId, namespace),
      clusterClient.listPods(clusterId, undefined, namespace),
    ]).then(([deployments, replicaSets, controllers, services, pods]): NamespaceWorkloads => ({
      deployments,
      replicaSets,
      controllers,
      services,
      pods,
    })),
  );

  if (state.status === 'loading') {
    return <p className="kos-taskmanager__status">Loading namespace workloads…</p>;
  }
  if (state.status === 'error') {
    return <p className="kos-taskmanager__status is-error">{state.message}</p>;
  }

  const { deployments, replicaSets, controllers, services, pods } = state.data;
  const replicasMeta = (replicas: { desired: number; ready: number }): string =>
    `${replicas.ready}/${replicas.desired} ready`;

  return (
    <div className="kos-taskmanager__workloads">
      <section>
        <h3 className="kos-taskmanager__section-title">Deployments</h3>
        <AsyncList
          state={{ status: 'ready', data: deployments }}
          emptyText="No deployments"
          toRow={(deployment) => ({
            key: deployment.name,
            title: deployment.name,
            meta: replicasMeta(deployment.replicas),
            onClick: () => undefined,
          })}
        />
      </section>
      <section>
        <h3 className="kos-taskmanager__section-title">Replica sets</h3>
        <AsyncList
          state={{ status: 'ready', data: replicaSets }}
          emptyText="No replica sets"
          toRow={(replicaSet) => ({
            key: replicaSet.name,
            title: replicaSet.name,
            meta: replicasMeta(replicaSet.replicas),
            onClick: () => undefined,
          })}
        />
      </section>
      <section>
        <h3 className="kos-taskmanager__section-title">Replication controllers</h3>
        <AsyncList
          state={{ status: 'ready', data: controllers }}
          emptyText="No replication controllers"
          toRow={(controller) => ({
            key: controller.name,
            title: controller.name,
            meta: replicasMeta(controller.replicas),
            onClick: () => undefined,
          })}
        />
      </section>
      <section>
        <h3 className="kos-taskmanager__section-title">Services</h3>
        <AsyncList
          state={{ status: 'ready', data: services }}
          emptyText="No services"
          toRow={(service) => ({
            key: service.name,
            title: service.name,
            meta: `${service.type} ${service.clusterIP}`,
            onClick: () => undefined,
          })}
        />
      </section>
      <section>
        <h3 className="kos-taskmanager__section-title">Pods</h3>
        <AsyncList
          state={{ status: 'ready', data: pods }}
          emptyText="No pods"
          toRow={(pod) => ({
            key: pod.name,
            title: pod.name,
            meta: pod.node ?? pod.phase,
            onClick: () => onSelectPod(pod.name),
          })}
        />
      </section>
    </div>
  );
}

function PodLogsView({
  clusterId,
  namespace,
  podName,
}: {
  clusterId: string;
  namespace: string;
  podName: string;
}) {
  const [container, setContainer] = useState('');
  const [tailLines, setTailLines] = useState(200);
  const state = useLoaded(
    `logs:${clusterId}:${namespace}:${podName}:${container}:${tailLines}`,
    () =>
      clusterClient.getPodLogs(
        clusterId,
        namespace,
        podName,
        container === '' ? undefined : container,
        tailLines,
      ),
  );

  const handleTailChange = (value: string) => {
    const parsed = Number(value);
    setTailLines(Number.isFinite(parsed) && parsed >= 0 ? parsed : 0);
  };

  return (
    <div className="kos-taskmanager__logs-view">
      <div className="kos-taskmanager__logs-controls">
        <AutoSuggestBox
          placeholder="Container (optional)"
          value={container}
          onChange={setContainer}
        />
        <label className="kos-taskmanager__tail">
          Tail lines
          <input
            className="kos-taskmanager__tail-input"
            type="number"
            min={0}
            value={tailLines}
            onChange={(event) => handleTailChange(event.target.value)}
          />
        </label>
      </div>
      {state.status === 'loading' ? (
        <p className="kos-taskmanager__status">Loading logs…</p>
      ) : state.status === 'error' ? (
        <p className="kos-taskmanager__status is-error">{state.message}</p>
      ) : state.data === '' ? (
        <p className="kos-taskmanager__status">No logs available</p>
      ) : (
        <pre className="kos-taskmanager__logs">{state.data}</pre>
      )}
    </div>
  );
}

function ClustersView({
  state,
  onSelect,
}: {
  state: AsyncState<readonly { id: string; name: string; server: string }[]>;
  onSelect: (clusterId: string) => void;
}) {
  if (state.status === 'loading') {
    return <p className="kos-taskmanager__status">Loading clusters…</p>;
  }
  if (state.status === 'error' || state.data.length === 0) {
    return <p className="kos-taskmanager__status">No clusters configured — start the Go server</p>;
  }
  return (
    <ListView>
      {state.data.map((cluster) => (
        <Row
          key={cluster.id}
          item={{
            key: cluster.id,
            title: cluster.name,
            meta: cluster.server,
            onClick: () => onSelect(cluster.id),
          }}
        />
      ))}
    </ListView>
  );
}

export function TaskManager(_props: WindowAppProps) {
  const [stack, setStack] = useState<readonly View[]>([{ kind: 'clusters' }]);
  const clusters = useLoaded('clusters', () => clusterClient.listClusters());
  const current = stack[stack.length - 1];

  const push = (view: View) => setStack((prev) => [...prev, view]);
  const pop = () => setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  const setClusterSection = (section: 'nodes' | 'namespaces') => {
    setStack((prev) => {
      const last = prev[prev.length - 1];
      if (prev.length === 0 || last.kind !== 'cluster') return prev;
      const next: View = { kind: 'cluster', clusterId: last.clusterId, section };
      return [...prev.slice(0, -1), next];
    });
  };

  useEffect(() => {
    if (clusters.status !== 'ready' || clusters.data.length !== 1) return;
    setStack((prev) => {
      if (prev.length > 1) return prev;
      return [...prev, { kind: 'cluster', clusterId: clusters.data[0].id, section: 'nodes' }];
    });
  }, [clusters]);

  const clusterName = (clusterId: string): string => {
    if (clusters.status === 'ready') {
      const match = clusters.data.find((cluster) => cluster.id === clusterId);
      if (match) return match.name;
    }
    return clusterId;
  };

  const crumbs = stack.map((view, index) => ({
    label:
      view.kind === 'clusters'
        ? 'Clusters'
        : view.kind === 'cluster'
          ? clusterName(view.clusterId)
          : view.kind === 'node'
            ? view.nodeName
            : view.kind === 'namespace'
              ? view.namespace
              : view.podName,
    target: index + 1,
  }));
  const activateCrumb = (target: number) =>
    setStack((prev) => (target === 0 ? [{ kind: 'clusters' }] : prev.slice(0, target)));

  let content: ReactNode;
  if (current.kind === 'clusters') {
    content = (
      <ClustersView
        state={clusters}
        onSelect={(clusterId) => push({ kind: 'cluster', clusterId, section: 'nodes' })}
      />
    );
  } else if (current.kind === 'cluster') {
    content = (
      <div className="kos-taskmanager__section">
        <div className="kos-taskmanager__tabs">
          <AppBarButton
            label="Nodes"
            active={current.section === 'nodes'}
            onClick={() => setClusterSection('nodes')}
            title="List nodes"
          />
          <AppBarButton
            label="Namespaces"
            active={current.section === 'namespaces'}
            onClick={() => setClusterSection('namespaces')}
            title="List namespaces"
          />
        </div>
        {current.section === 'nodes' ? (
          <ClusterNodesView
            clusterId={current.clusterId}
            onSelectNode={(nodeName) =>
              push({ kind: 'node', clusterId: current.clusterId, nodeName })
            }
          />
        ) : (
          <ClusterNamespacesView
            clusterId={current.clusterId}
            onSelectNamespace={(namespace) =>
              push({ kind: 'namespace', clusterId: current.clusterId, namespace })
            }
          />
        )}
      </div>
    );
  } else if (current.kind === 'node') {
    content = <NodeDetailView clusterId={current.clusterId} nodeName={current.nodeName} />;
  } else if (current.kind === 'namespace') {
    content = (
      <NamespaceView
        clusterId={current.clusterId}
        namespace={current.namespace}
        onSelectPod={(pod) =>
          push({
            kind: 'pod',
            clusterId: current.clusterId,
            namespace: current.namespace,
            podName: pod,
          })
        }
      />
    );
  } else {
    content = (
      <PodLogsView
        clusterId={current.clusterId}
        namespace={current.namespace}
        podName={current.podName}
      />
    );
  }

  return (
    <div className="kos-taskmanager">
      <header className="kos-taskmanager__toolbar">
        {stack.length > 1 ? (
          <Tooltip content="Go back">
            <AppBarButton label="Back" onClick={pop} title="Go back" />
          </Tooltip>
        ) : null}
        <nav className="kos-taskmanager__breadcrumbs" aria-label="Breadcrumb">
          {crumbs.map((crumb, index) => (
            <span className="kos-taskmanager__crumb" key={crumb.target}>
              {index > 0 ? <Icon name="chevron-right" size={12} /> : null}
              <button
                type="button"
                className="kos-taskmanager__crumb-button"
                onClick={() => activateCrumb(crumb.target)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
      </header>
      <div className="kos-taskmanager__content">{content}</div>
    </div>
  );
}

function ClusterNodesView({
  clusterId,
  onSelectNode,
}: {
  clusterId: string;
  onSelectNode: (nodeName: string) => void;
}) {
  const state = useLoaded(`nodes:${clusterId}`, () => clusterClient.listNodes(clusterId));
  return (
    <div className="kos-taskmanager__section">
      <AsyncList
        state={state}
        emptyText="No nodes"
        toRow={(node: NodeInfo) => ({
          key: node.name,
          title: node.name,
          meta: node.status,
          onClick: () => onSelectNode(node.name),
        })}
      />
    </div>
  );
}

function ClusterNamespacesView({
  clusterId,
  onSelectNamespace,
}: {
  clusterId: string;
  onSelectNamespace: (namespace: string) => void;
}) {
  const state = useLoaded(`namespaces:${clusterId}`, () => clusterClient.listNamespaces(clusterId));
  return (
    <div className="kos-taskmanager__section">
      <AsyncList
        state={state}
        emptyText="No namespaces"
        toRow={(namespace: NamespaceInfo) => ({
          key: namespace.name,
          title: namespace.name,
          meta: namespace.status,
          onClick: () => onSelectNamespace(namespace.name),
        })}
      />
    </div>
  );
}

export default TaskManager;
