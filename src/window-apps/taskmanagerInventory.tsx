// Inventory pages (V4, Phase 3): Pods / Namespaces / Nodes / Settings — InventoryView as in types.
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { clusterClient } from '../cluster/client';
import type { NamespaceInfo, NodeInfo, PodInfo } from '../cluster/client';
import { WorkloadActions } from './taskmanagerActions';
import {
  DetailFlyout,
  FlyoutSection,
  KeyValueList,
  NodeDetailPanel,
  PodLogsPanel,
} from './taskmanagerFlyout';
import { formatBytes, formatCpu } from './taskmanagerFormat';
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
  const [selectedPod, setSelectedPod] = useState<PodInfo | null>(null);
  const [selectedNode, setSelectedNode] = useState<NodeInfo | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // A stale flyout must never survive a page/cluster/namespace change.
  useEffect(() => {
    setSelectedPod(null);
    setSelectedNode(null);
  }, [page, clusterId, namespace]);

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
  }, [clusterId, namespace, reloadNonce]);

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
          onActivate={(row) => setSelectedPod(row)}
          activeKey={selectedPod === null ? undefined : podRowKey(selectedPod)}
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
          onActivate={(row) => setSelectedNode(row)}
          activeKey={selectedNode?.name}
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

  const selectedPodMetrics =
    selectedPod === null
      ? undefined
      : podMetricsMap.get(`${selectedPod.namespace}/${selectedPod.name}`);
  const selectedPodLabels =
    selectedPod === null
      ? []
      : Object.entries(selectedPod.labels ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const hasFlyout =
    (page === 'pods' && selectedPod !== null) || (page === 'nodes' && selectedNode !== null);

  return (
    <div
      className={
        hasFlyout
          ? 'kos-tm-view kos-tm-view--inventory has-flyout'
          : 'kos-tm-view kos-tm-view--inventory'
      }
      data-page={page}
      data-speed={updateSpeed}
    >
      <div className="kos-tm-view__body">{renderContent()}</div>
      {page === 'pods' && selectedPod !== null && (
        <DetailFlyout
          title={selectedPod.name}
          subtitle={`${selectedPod.namespace} · ${selectedPod.phase}`}
          ariaLabel={`Pod details — ${selectedPod.name}`}
          onClose={() => setSelectedPod(null)}
        >
          <FlyoutSection title="Summary">
            <KeyValueList
              items={[
                { key: 'Namespace', value: selectedPod.namespace },
                { key: 'Node', value: selectedPod.node ?? '' },
                { key: 'Phase', value: selectedPod.phase },
                {
                  key: 'Owner',
                  value: `${selectedPod.ownerKind ?? ''} ${selectedPod.ownerName ?? ''}`.trim(),
                },
                ...(selectedPodMetrics?.cpuMillis !== undefined
                  ? [{ key: 'CPU', value: formatCpu(selectedPodMetrics.cpuMillis) }]
                  : []),
                ...(selectedPodMetrics?.memoryBytes !== undefined
                  ? [{ key: 'Memory', value: formatBytes(selectedPodMetrics.memoryBytes) }]
                  : []),
              ]}
            />
          </FlyoutSection>
          <FlyoutSection title="Actions">
            <WorkloadActions
              clusterId={clusterId}
              target={{
                kind: 'pod',
                name: selectedPod.name,
                namespace: selectedPod.namespace,
              }}
              onComplete={() => {
                setSelectedPod(null);
                setReloadNonce((value) => value + 1);
              }}
            />
          </FlyoutSection>
          <FlyoutSection title="Labels">
            {selectedPodLabels.length > 0 ? (
              <ul className="kos-tm-flyout__list">
                {selectedPodLabels.map(([key, value]) => (
                  <li key={key}>
                    <code>{`${key}=${value}`}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="kos-tm-flyout__hint">No labels.</p>
            )}
          </FlyoutSection>
          <FlyoutSection title="Logs">
            <PodLogsPanel
              clusterId={clusterId}
              namespace={selectedPod.namespace}
              pod={selectedPod.name}
            />
          </FlyoutSection>
        </DetailFlyout>
      )}
      {page === 'nodes' && selectedNode !== null && (
        <DetailFlyout
          title={selectedNode.name}
          subtitle={selectedNode.status}
          ariaLabel={`Node details — ${selectedNode.name}`}
          onClose={() => setSelectedNode(null)}
        >
          <NodeDetailPanel clusterId={clusterId} name={selectedNode.name} />
        </DetailFlyout>
      )}
    </div>
  );
}
