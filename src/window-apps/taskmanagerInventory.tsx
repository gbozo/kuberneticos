// Inventory pages (V4, Phase 3): Pods / Namespaces / Nodes / Settings — InventoryView as in types.
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { clusterClient } from '../cluster/client';
import type { NamespaceInfo, NodeInfo, PodInfo } from '../cluster/client';
import { DataTable } from './taskmanagerTable';
import type { DataTableColumn } from './taskmanagerTable';
import type { TaskManagerInventoryProps } from './taskmanagerTypes';
import { usePolledMetrics } from './taskmanagerHooks';
import { indexPodMetrics } from './taskmanagerData';

function podRowKey(pod: PodInfo): string {
  return `${pod.namespace}/${pod.name}`;
}

function nsRowKey(ns: NamespaceInfo): string {
  return ns.name;
}

function nodeRowKey(node: NodeInfo): string {
  return node.name;
}

export function InventoryView(props: TaskManagerInventoryProps): ReactElement {
  const { clusterId, namespace, updateSpeed, page } = props;

  const metrics = usePolledMetrics({
    clusterId,
    namespace: namespace == null ? undefined : namespace,
    updateSpeed,
  });

  const [pods, setPods] = useState<readonly PodInfo[]>([]);
  const [namespaces, setNamespaces] = useState<readonly NamespaceInfo[]>([]);
  const [nodes, setNodes] = useState<readonly NodeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (clusterId === undefined || clusterId === '') {
      setPods([]);
      setNamespaces([]);
      setNodes([]);
      setLoading(false);
      setError(null);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    const load = async (): Promise<void> => {
      try {
        const [p, ns, n] = await Promise.all([
          clusterClient.listPods(clusterId, undefined, namespace == null ? undefined : namespace),
          clusterClient.listNamespaces(clusterId),
          clusterClient.listNodes(clusterId),
        ]);
        if (!active) return;
        setPods(p);
        setNamespaces(ns);
        setNodes(n);
        setLoading(false);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };

    void load();

    return () => {
      active = false;
    };
  }, [clusterId, namespace]);

  const podMetricsMap = useMemo(() => indexPodMetrics(metrics.pods), [metrics.pods]);

  const podColumns: readonly DataTableColumn<PodInfo>[] = useMemo(
    () => [
      { key: 'name', title: 'Name', render: (row) => row.name },
      { key: 'namespace', title: 'Namespace', render: (row) => row.namespace },
      { key: 'node', title: 'Node', render: (row) => row.node ?? '' },
      { key: 'phase', title: 'Phase', render: (row) => row.phase },
      { key: 'owner', title: 'Owner', render: (row) => row.ownerName ?? '' },
      {
        key: 'cpu',
        title: 'CPU',
        align: 'end',
        render: (row) => {
          const m = podMetricsMap.get(`${row.namespace}/${row.name}`);
          return m?.cpuMillis !== undefined ? `${m.cpuMillis}m` : '';
        },
      },
      {
        key: 'memory',
        title: 'Memory',
        align: 'end',
        render: (row) => {
          const m = podMetricsMap.get(`${row.namespace}/${row.name}`);
          return m?.memoryBytes !== undefined ? `${Math.round(m.memoryBytes / 1024 / 1024)}Mi` : '';
        },
      },
    ],
    [podMetricsMap],
  );

  const nsColumns: readonly DataTableColumn<NamespaceInfo>[] = useMemo(
    () => [
      { key: 'name', title: 'Name', render: (row) => row.name },
      { key: 'status', title: 'Status', render: (row) => row.status },
    ],
    [],
  );

  const nodeColumns: readonly DataTableColumn<NodeInfo>[] = useMemo(
    () => [
      { key: 'name', title: 'Name', render: (row) => row.name },
      { key: 'status', title: 'Status', render: (row) => row.status },
      { key: 'roles', title: 'Roles', render: (row) => row.roles.join(', ') },
      { key: 'version', title: 'Version', render: (row) => row.version ?? '' },
    ],
    [],
  );

  const renderContent = (): ReactElement => {
    if (page === 'pods') {
      return (
        <DataTable<PodInfo>
          columns={podColumns}
          rows={pods}
          rowKey={podRowKey}
          loading={loading}
          error={error}
          emptyMessage="No pods found"
          ariaLabel="Pods"
        />
      );
    }
    if (page === 'namespaces') {
      return (
        <DataTable<NamespaceInfo>
          columns={nsColumns}
          rows={namespaces}
          rowKey={nsRowKey}
          loading={loading}
          error={error}
          emptyMessage="No namespaces found"
          ariaLabel="Namespaces"
        />
      );
    }
    if (page === 'nodes') {
      return (
        <DataTable<NodeInfo>
          columns={nodeColumns}
          rows={nodes}
          rowKey={nodeRowKey}
          loading={loading}
          error={error}
          emptyMessage="No nodes found"
          ariaLabel="Nodes"
        />
      );
    }
    // settings
    return (
      <div className="kos-tm-settings">
        <div>Update Speed: {updateSpeed}</div>
        <div>Namespace: {namespace ?? 'all'}</div>
      </div>
    );
  };

  return (
    <div className="kos-tm-view kos-tm-view--inventory" data-page={page} data-speed={updateSpeed}>
      {renderContent()}
    </div>
  );
}
