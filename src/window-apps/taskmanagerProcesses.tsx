// Workloads page (V1, Phase 3) — Workloads tree view using DataTable + filters/groupBy + rollup.
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { clusterClient } from '../cluster/client';
import type {
  DeploymentInfo,
  PodInfo,
  ReplicaSetInfo,
  ReplicationControllerInfo,
} from '../cluster/client';
import { WorkloadActions } from './taskmanagerActions';
import type { WorkloadActionTarget } from './taskmanagerActions';
import {
  buildWorkloadTree,
  filterNodes,
  groupBy,
  indexPodMetrics,
  rollupMetrics,
  sortNodes,
} from './taskmanagerData';
import type { SortDirection, SortKey } from './taskmanagerData';
import { DetailFlyout, FlyoutSection, KeyValueList, PodLogsPanel } from './taskmanagerFlyout';
import { formatBytes, formatCpu, formatRate } from './taskmanagerFormat';
import { usePolledMetrics } from './taskmanagerHooks';
import { DataTable } from './taskmanagerTable';
import type { DataTableColumn, DataTableSort } from './taskmanagerTable';
import type { GroupBy, TaskManagerViewProps, WorkloadNode } from './taskmanagerTypes';

function rowKey(node: WorkloadNode): string {
  return node.id;
}

function depth(node: WorkloadNode): number {
  return node.depth;
}

/** Scale a raw consumption value against the tree maximum to a 0–100 heat value. */
function normalizeHeat(value: number, max: number): number | null {
  return max > 0 ? (value / max) * 100 : null;
}

const GROUP_BY_OPTIONS: readonly { value: GroupBy; label: string }[] = [
  { value: 'deployment', label: 'Deployment' },
  { value: 'replicaset', label: 'ReplicaSet' },
  { value: 'pod', label: 'Pod' },
  { value: 'namespace', label: 'Namespace' },
  { value: 'node', label: 'Node' },
];

export function ProcessesView(props: TaskManagerViewProps): ReactElement {
  const { clusterId, namespace, updateSpeed } = props;
  const [deployments, setDeployments] = useState<readonly DeploymentInfo[]>([]);
  const [replicaSets, setReplicaSets] = useState<readonly ReplicaSetInfo[]>([]);
  const [controllers, setControllers] = useState<readonly ReplicationControllerInfo[]>([]);
  const [pods, setPods] = useState<readonly PodInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [groupByMode, setGroupByMode] = useState<GroupBy>('deployment');
  const [sort, setSort] = useState<DataTableSort>({ key: 'name', dir: 'asc' });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<WorkloadNode | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const metrics = usePolledMetrics({
    clusterId,
    namespace: namespace == null ? undefined : namespace,
    updateSpeed,
  });

  useEffect(() => {
    // Data reloads whenever the cluster or namespace changes — a stale selection
    // must never keep pointing at rows that are about to disappear.
    setSelected(null);
    if (clusterId === undefined || clusterId === '') {
      setDeployments([]);
      setReplicaSets([]);
      setControllers([]);
      setPods([]);
      setLoading(false);
      setError(null);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    void Promise.all([
      clusterClient.listDeployments(clusterId, namespace == null ? undefined : namespace),
      clusterClient.listReplicaSets(clusterId, namespace == null ? undefined : namespace),
      clusterClient.listReplicationControllers(
        clusterId,
        namespace == null ? undefined : namespace,
      ),
      clusterClient.listPods(clusterId, undefined, namespace == null ? undefined : namespace),
    ])
      .then(([d, rs, c, p]) => {
        if (!active) return;
        setDeployments(d);
        setReplicaSets(rs);
        setControllers(c);
        setPods(p);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [clusterId, namespace, reloadNonce]);

  const tree = useMemo(() => {
    const base = buildWorkloadTree(deployments, replicaSets, controllers, pods);
    const podMetricsByKey = indexPodMetrics(metrics.pods);
    const attachMetrics = (node: WorkloadNode): WorkloadNode => {
      if (node.kind === 'pod') {
        const m = podMetricsByKey.get(`${node.namespace ?? 'default'}/${node.name}`);
        return {
          ...node,
          cpuMillis: m?.cpuMillis,
          memoryBytes: m?.memoryBytes,
          diskUsedBytes: m?.diskUsedBytes,
          networkRxBytes: m?.networkRxBytes,
          networkTxBytes: m?.networkTxBytes,
        };
      }
      return { ...node, children: node.children.map(attachMetrics) };
    };
    const enriched = base.map(attachMetrics);
    const rolled = enriched.map(rollupMetrics);
    const grouped = groupBy(rolled, groupByMode);
    const filtered = filterNodes(grouped, search);
    return sortNodes(filtered, sort.key as SortKey, sort.dir as SortDirection);
  }, [
    deployments,
    replicaSets,
    controllers,
    pods,
    metrics.pods,
    groupByMode,
    search,
    sort.key,
    sort.dir,
  ]);

  const heatMaxima = useMemo(() => {
    let cpu = 0;
    let memory = 0;
    let disk = 0;
    let network = 0;
    const walk = (nodes: readonly WorkloadNode[]): void => {
      for (const node of nodes) {
        cpu = Math.max(cpu, node.cpuMillis ?? 0);
        memory = Math.max(memory, node.memoryBytes ?? 0);
        disk = Math.max(disk, node.diskUsedBytes ?? 0);
        network = Math.max(network, (node.networkRxBytes ?? 0) + (node.networkTxBytes ?? 0));
        walk(node.children);
      }
    };
    walk(tree);
    return { cpu, memory, disk, network };
  }, [tree]);

  const handleSort = (key: string): void => {
    setSort((prev) => {
      if (prev.key === key) {
        return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
      }
      return { key, dir: 'asc' };
    });
  };

  const handleToggle = (row: WorkloadNode): void => {
    const key = rowKey(row);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const columns: readonly DataTableColumn<WorkloadNode>[] = useMemo(
    () => [
      {
        key: 'name',
        title: 'Name',
        render: (row) => row.name,
      },
      {
        key: 'status',
        title: 'Status',
        render: (row) => row.status ?? '',
      },
      {
        key: 'cpu',
        title: 'CPU',
        align: 'end',
        heat: true,
        heatValue: (row) => normalizeHeat(row.cpuMillis ?? 0, heatMaxima.cpu),
        render: (row) => (row.cpuMillis !== undefined ? `${row.cpuMillis}m` : ''),
      },
      {
        key: 'memory',
        title: 'Memory',
        align: 'end',
        heat: true,
        heatValue: (row) => normalizeHeat(row.memoryBytes ?? 0, heatMaxima.memory),
        render: (row) =>
          row.memoryBytes !== undefined ? `${Math.round(row.memoryBytes / 1024 / 1024)}Mi` : '',
      },
      {
        key: 'disk',
        title: 'Disk',
        align: 'end',
        heat: true,
        heatValue: (row) => normalizeHeat(row.diskUsedBytes ?? 0, heatMaxima.disk),
        render: (row) =>
          row.diskUsedBytes !== undefined ? `${Math.round(row.diskUsedBytes / 1024 / 1024)}Mi` : '',
      },
      {
        key: 'network',
        title: 'Network',
        align: 'end',
        heat: true,
        heatValue: (row) =>
          normalizeHeat((row.networkRxBytes ?? 0) + (row.networkTxBytes ?? 0), heatMaxima.network),
        render: (row) => {
          const total = (row.networkRxBytes ?? 0) + (row.networkTxBytes ?? 0);
          return total > 0 ? `${Math.round(total / 1024)}Ki` : '';
        },
      },
    ],
    [heatMaxima],
  );

  const actionTarget: WorkloadActionTarget | null =
    selected === null || selected.namespace === undefined
      ? null
      : selected.kind === 'pod'
        ? { kind: 'pod', name: selected.name, namespace: selected.namespace }
        : selected.kind === 'deployment'
          ? {
              kind: 'deployment',
              name: selected.name,
              namespace: selected.namespace,
              replicas: selected.desiredReplicas,
            }
          : null;

  return (
    <div
      className={
        selected === null
          ? 'kos-tm-view kos-tm-view--workloads'
          : 'kos-tm-view kos-tm-view--workloads has-flyout'
      }
      data-page="workloads"
      data-speed={updateSpeed}
    >
      <div className="kos-tm-toolbar">
        <input
          type="text"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="kos-tm-search"
          aria-label="Search workloads"
        />
        <select
          value={groupByMode}
          onChange={(e) => setGroupByMode(e.target.value as GroupBy)}
          className="kos-tm-select"
          aria-label="Group by"
        >
          {GROUP_BY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div className="kos-tm-view__body">
        <DataTable<WorkloadNode>
          columns={columns}
          rows={tree}
          rowKey={rowKey}
          sort={sort}
          onSort={handleSort}
          tree
          depth={depth}
          expanded={expanded}
          onToggle={handleToggle}
          onActivate={(row) => setSelected(row)}
          activeKey={selected?.id}
          loading={loading}
          error={error}
          emptyMessage="No workloads found"
          ariaLabel="Workloads"
        />
      </div>
      {selected !== null && (
        <DetailFlyout
          title={selected.name}
          subtitle={`${selected.kind} · ${selected.namespace ?? 'all namespaces'}`}
          ariaLabel={`Workload details — ${selected.name}`}
          onClose={() => setSelected(null)}
        >
          <FlyoutSection title="Summary">
            <KeyValueList
              items={[
                { key: 'Kind', value: selected.kind },
                { key: 'Namespace', value: selected.namespace ?? '' },
                { key: 'Status', value: selected.status ?? '' },
                ...(selected.cpuMillis !== undefined
                  ? [{ key: 'CPU', value: formatCpu(selected.cpuMillis) }]
                  : []),
                ...(selected.memoryBytes !== undefined
                  ? [{ key: 'Memory', value: formatBytes(selected.memoryBytes) }]
                  : []),
                ...(selected.diskUsedBytes !== undefined
                  ? [{ key: 'Disk', value: formatBytes(selected.diskUsedBytes) }]
                  : []),
                ...(selected.networkRxBytes !== undefined
                  ? [{ key: 'Network In', value: formatRate(selected.networkRxBytes) }]
                  : []),
                ...(selected.networkTxBytes !== undefined
                  ? [{ key: 'Network Out', value: formatRate(selected.networkTxBytes) }]
                  : []),
                ...(selected.podCount !== undefined
                  ? [{ key: 'Pods', value: String(selected.podCount) }]
                  : []),
              ]}
            />
          </FlyoutSection>
          {actionTarget !== null && (
            <FlyoutSection title="Actions">
              <WorkloadActions
                clusterId={clusterId}
                target={actionTarget}
                onComplete={() => {
                  setSelected(null);
                  setReloadNonce((value) => value + 1);
                }}
              />
            </FlyoutSection>
          )}
          <FlyoutSection title="Children">
            {selected.children.length > 0 ? (
              <ul className="kos-tm-flyout__list">
                {selected.children.map((child) => (
                  <li key={child.id}>
                    <span>{child.name}</span>
                    <span className="kos-tm-flyout__muted">{child.kind}</span>
                    {child.cpuMillis !== undefined && (
                      <span className="kos-tm-flyout__muted">{formatCpu(child.cpuMillis)}</span>
                    )}
                    {child.memoryBytes !== undefined && (
                      <span className="kos-tm-flyout__muted">{formatBytes(child.memoryBytes)}</span>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="kos-tm-flyout__hint">No children.</p>
            )}
          </FlyoutSection>
          {selected.kind === 'pod' && selected.namespace !== undefined && (
            <FlyoutSection title="Logs">
              <PodLogsPanel
                clusterId={clusterId}
                namespace={selected.namespace}
                pod={selected.name}
              />
            </FlyoutSection>
          )}
        </DetailFlyout>
      )}
    </div>
  );
}
