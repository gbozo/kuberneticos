// Pure Task Manager 2.0 data helpers (Phase 0 stub; D1 in Phase 2 expands this).
// See tasks.md §6 D1: buildWorkloadTree / groupBy / indexPodMetrics / rollupMetrics /
// sortNodes / filterNodes / mergeSeries.
import type {
  DeploymentInfo,
  PodInfo,
  PodMetrics,
  ReplicaSetInfo,
  ReplicationControllerInfo,
} from '../cluster/client';
import type { GroupBy, SeriesSample, StatusTone, WorkloadNode } from './taskmanagerTypes';

export {
  formatBytes,
  formatCapacity,
  formatCpu,
  formatPercent,
  formatRate,
} from './taskmanagerFormat';

export type SortKey = 'name' | 'status' | 'cpu' | 'memory' | 'disk' | 'network';
export type SortDirection = 'asc' | 'desc';

const ownerKey = (namespace: string, name: string): string => `${namespace}/${name}`;

function statusTone(status: string | undefined): StatusTone {
  switch (status) {
    case 'Running':
    case 'Ready':
    case 'Active':
      return 'ok';
    case 'Pending':
      return 'warn';
    case 'Failed':
    case 'CrashLoopBackOff':
    case 'NotReady':
      return 'danger';
    default:
      return 'muted';
  }
}

/** Index pod metrics by `namespace/name` (tasks.md §6 D1). */
export function indexPodMetrics(
  podMetrics: readonly PodMetrics[],
): ReadonlyMap<string, PodMetrics> {
  const index = new Map<string, PodMetrics>();
  for (const metrics of podMetrics) {
    index.set(ownerKey(metrics.namespace, metrics.name), metrics);
  }
  return index;
}

/**
 * Build the Deployment -> ReplicaSet -> Pod tree. Metric joins and
 * ReplicationController handling are completed by D1 in Phase 2.
 */
export function buildWorkloadTree(
  deployments: readonly DeploymentInfo[],
  replicaSets: readonly ReplicaSetInfo[],
  controllers: readonly ReplicationControllerInfo[],
  pods: readonly PodInfo[],
): readonly WorkloadNode[] {
  void controllers; // ReplicationControllers are folded into the tree by D1 (Phase 2).

  const podsByOwner = new Map<string, PodInfo[]>();
  for (const pod of pods) {
    if (!pod.ownerName) continue;
    const key = ownerKey(pod.namespace, pod.ownerName);
    const bucket = podsByOwner.get(key);
    if (bucket) bucket.push(pod);
    else podsByOwner.set(key, [pod]);
  }

  const rsByOwner = new Map<string, ReplicaSetInfo[]>();
  for (const rs of replicaSets) {
    if (!rs.ownerName) continue;
    const key = ownerKey(rs.namespace, rs.ownerName);
    const bucket = rsByOwner.get(key);
    if (bucket) bucket.push(rs);
    else rsByOwner.set(key, [rs]);
  }

  const podNode = (pod: PodInfo): WorkloadNode => ({
    id: `pod:${ownerKey(pod.namespace, pod.name)}`,
    kind: 'pod',
    name: pod.name,
    namespace: pod.namespace,
    status: pod.phase,
    statusTone: statusTone(pod.phase),
    depth: 2,
    children: [],
  });

  const rsNode = (rs: ReplicaSetInfo): WorkloadNode => ({
    id: `replicaset:${ownerKey(rs.namespace, rs.name)}`,
    kind: 'replicaset',
    name: rs.name,
    namespace: rs.namespace,
    status: `${rs.replicas.ready}/${rs.replicas.desired}`,
    statusTone: rs.replicas.ready === rs.replicas.desired ? 'ok' : 'warn',
    depth: 1,
    children: (podsByOwner.get(ownerKey(rs.namespace, rs.name)) ?? []).map(podNode),
  });

  return deployments.map<WorkloadNode>((deployment) => ({
    id: `deployment:${ownerKey(deployment.namespace, deployment.name)}`,
    kind: 'deployment',
    name: deployment.name,
    namespace: deployment.namespace,
    status: `${deployment.replicas.ready}/${deployment.replicas.desired}`,
    statusTone: deployment.replicas.ready === deployment.replicas.desired ? 'ok' : 'warn',
    depth: 0,
    children: (rsByOwner.get(ownerKey(deployment.namespace, deployment.name)) ?? []).map(rsNode),
  }));
}

/**
 * Roll child metrics up to a parent (a parent equals the sum of its descendants).
 * Capacity is intentionally not summed.
 */
export function rollupMetrics(node: WorkloadNode): WorkloadNode {
  const children = node.children.map(rollupMetrics);
  if (children.length === 0) return { ...node, children };

  const sum = (pick: (child: WorkloadNode) => number | undefined): number | undefined => {
    let total = 0;
    let seen = false;
    for (const child of children) {
      const value = pick(child);
      if (value !== undefined) {
        total += value;
        seen = true;
      }
    }
    return seen ? total : undefined;
  };

  return {
    ...node,
    children,
    podCount: sum((child) => child.podCount ?? (child.kind === 'pod' ? 1 : 0)),
    cpuMillis: sum((child) => child.cpuMillis),
    memoryBytes: sum((child) => child.memoryBytes),
    diskUsedBytes: sum((child) => child.diskUsedBytes),
    networkRxBytes: sum((child) => child.networkRxBytes),
    networkTxBytes: sum((child) => child.networkTxBytes),
  };
}

/** Regroup tree roots. Only the default (deployment) mode exists in Phase 0. */
export function groupBy(nodes: readonly WorkloadNode[], mode: GroupBy): readonly WorkloadNode[] {
  void mode; // ReplicaSet/Pod/Namespace/Node grouping lands in D1 (Phase 2).
  return nodes;
}

const NUMERIC_SORT_KEYS: ReadonlySet<SortKey> = new Set<SortKey>([
  'cpu',
  'memory',
  'disk',
  'network',
]);

export function sortNodes(
  nodes: readonly WorkloadNode[],
  key: SortKey,
  direction: SortDirection,
): readonly WorkloadNode[] {
  const factor = direction === 'desc' ? -1 : 1;
  const numeric = NUMERIC_SORT_KEYS.has(key);

  const numericValue = (node: WorkloadNode): number => {
    switch (key) {
      case 'cpu':
        return node.cpuMillis ?? 0;
      case 'memory':
        return node.memoryBytes ?? 0;
      case 'disk':
        return node.diskUsedBytes ?? 0;
      case 'network':
        return (node.networkRxBytes ?? 0) + (node.networkTxBytes ?? 0);
      default:
        return 0;
    }
  };

  const textValue = (node: WorkloadNode): string =>
    (key === 'status' ? (node.status ?? '') : node.name).toLowerCase();

  const compare = (a: WorkloadNode, b: WorkloadNode): number => {
    if (numeric) {
      const diff = numericValue(a) - numericValue(b);
      return diff === 0 ? 0 : diff < 0 ? -factor : factor;
    }
    const av = textValue(a);
    const bv = textValue(b);
    return av === bv ? 0 : av < bv ? -factor : factor;
  };

  return [...nodes]
    .sort(compare)
    .map((node) => ({ ...node, children: sortNodes(node.children, key, direction) }));
}

export function filterNodes(
  nodes: readonly WorkloadNode[],
  query: string,
): readonly WorkloadNode[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return nodes;

  const walk = (list: readonly WorkloadNode[]): WorkloadNode[] => {
    const result: WorkloadNode[] = [];
    for (const node of list) {
      const children = walk(node.children);
      const matches = node.name.toLowerCase().includes(needle);
      if (matches || children.length > 0) {
        result.push(children.length === node.children.length ? node : { ...node, children });
      }
    }
    return result;
  };

  return walk(nodes);
}

/**
 * Append a sample only when the payload (value) changed, so the 15s metrics-server
 * resolution does not produce a staircase of repeated polls (tasks.md §4.1).
 */
export function mergeSeries(
  prev: readonly SeriesSample[],
  sample: SeriesSample | null,
  capacity = 60,
): readonly SeriesSample[] {
  if (sample === null) return prev;
  const last = prev[prev.length - 1];
  if (last !== undefined && last.v === sample.v) return prev;
  const next = [...prev, sample];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}
