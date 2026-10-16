// Pure Task Manager 2.0 data helpers (tasks.md §6 D1).
// Tree building, metric indexing, regrouping, sorting, filtering and the sample
// dedupe that keeps the performance charts free of repeated 15s polls.
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

export const UNOWNED_REPLICASETS_GROUP_ID = 'group:unowned-replicasets';
export const STANDALONE_PODS_GROUP_ID = 'group:standalone-pods';

const UNSCHEDULED_NODE = 'Unscheduled';

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

/** ReplicaSet/pod names are `<owner>-<hash>`; used when no owner reference exists. */
function stripLastSegment(name: string): string | undefined {
  const index = name.lastIndexOf('-');
  return index > 0 ? name.slice(0, index) : undefined;
}

function pushBucketed<T>(buckets: Map<string, T[]>, key: string, value: T): void {
  const bucket = buckets.get(key);
  if (bucket) bucket.push(value);
  else buckets.set(key, [value]);
}

function makePodNode(pod: PodInfo, depth: number): WorkloadNode {
  return {
    id: `pod:${ownerKey(pod.namespace, pod.name)}`,
    kind: 'pod',
    name: pod.name,
    namespace: pod.namespace,
    node: pod.node,
    status: pod.phase,
    statusTone: statusTone(pod.phase),
    depth,
    podCount: 1,
    children: [],
  };
}

function makeControllerNode(
  item: ReplicaSetInfo | ReplicationControllerInfo,
  pods: readonly PodInfo[],
  depth: number,
  idPrefix: string,
): WorkloadNode {
  const children = pods.map((pod) => makePodNode(pod, depth + 1));
  return {
    id: `${idPrefix}:${ownerKey(item.namespace, item.name)}`,
    kind: 'replicaset',
    name: item.name,
    namespace: item.namespace,
    status: `${item.replicas.ready}/${item.replicas.desired}`,
    statusTone: item.replicas.ready === item.replicas.desired ? 'ok' : 'warn',
    depth,
    podCount: children.length,
    desiredReplicas: item.replicas.desired,
    children,
  };
}

type PodOwner =
  | { readonly kind: 'replicaset'; readonly key: string }
  | { readonly kind: 'replicationcontroller'; readonly key: string }
  | { readonly kind: 'standalone' };

function resolvePodOwner(
  pod: PodInfo,
  rsKeys: ReadonlySet<string>,
  rcKeys: ReadonlySet<string>,
): PodOwner {
  const ownerKind = pod.ownerKind;
  if (pod.ownerName !== undefined && pod.ownerName !== '') {
    const key = ownerKey(pod.namespace, pod.ownerName);
    if (ownerKind === 'ReplicationController') {
      return rcKeys.has(key) ? { kind: 'replicationcontroller', key } : { kind: 'standalone' };
    }
    if (ownerKind === undefined || ownerKind === 'ReplicaSet') {
      return rsKeys.has(key) ? { kind: 'replicaset', key } : { kind: 'standalone' };
    }
    return { kind: 'standalone' };
  }
  if (ownerKind === undefined || ownerKind === 'ReplicaSet') {
    const candidate = stripLastSegment(pod.name);
    if (candidate !== undefined) {
      const key = ownerKey(pod.namespace, candidate);
      if (rsKeys.has(key)) return { kind: 'replicaset', key };
    }
  }
  return { kind: 'standalone' };
}

function resolveDeploymentName(
  rs: ReplicaSetInfo,
  deploymentKeys: ReadonlySet<string>,
): string | undefined {
  const ownerKind = rs.ownerKind;
  if (rs.ownerName !== undefined && rs.ownerName !== '') {
    if (
      (ownerKind === undefined || ownerKind === 'Deployment') &&
      deploymentKeys.has(ownerKey(rs.namespace, rs.ownerName))
    ) {
      return rs.ownerName;
    }
  }
  const candidate = stripLastSegment(rs.name);
  if (candidate !== undefined && deploymentKeys.has(ownerKey(rs.namespace, candidate))) {
    return candidate;
  }
  return undefined;
}

/**
 * Build the Deployment (depth 0) → ReplicaSet (1) → Pod (2) tree.
 *
 * ReplicaSets without a matching Deployment are collected under the synthetic
 * `Unowned ReplicaSets` root; pods whose owner is missing from the tree (or that
 * have no owner at all) are collected under the synthetic `Standalone pods`
 * root. ReplicationControllers become top-level controllers with their pods.
 */
export function buildWorkloadTree(
  deployments: readonly DeploymentInfo[],
  replicaSets: readonly ReplicaSetInfo[],
  controllers: readonly ReplicationControllerInfo[],
  pods: readonly PodInfo[],
): readonly WorkloadNode[] {
  const deploymentKeys = new Set(deployments.map((d) => ownerKey(d.namespace, d.name)));
  const rsKeys = new Set(replicaSets.map((rs) => ownerKey(rs.namespace, rs.name)));
  const rcKeys = new Set(controllers.map((rc) => ownerKey(rc.namespace, rc.name)));

  const podsByRs = new Map<string, PodInfo[]>();
  const podsByRc = new Map<string, PodInfo[]>();
  const standalonePods: PodInfo[] = [];
  for (const pod of pods) {
    const owner = resolvePodOwner(pod, rsKeys, rcKeys);
    if (owner.kind === 'replicaset') pushBucketed(podsByRs, owner.key, pod);
    else if (owner.kind === 'replicationcontroller') pushBucketed(podsByRc, owner.key, pod);
    else standalonePods.push(pod);
  }

  const rsByDeployment = new Map<string, ReplicaSetInfo[]>();
  const unownedRs: ReplicaSetInfo[] = [];
  for (const rs of replicaSets) {
    const deploymentName = resolveDeploymentName(rs, deploymentKeys);
    if (deploymentName === undefined) unownedRs.push(rs);
    else pushBucketed(rsByDeployment, ownerKey(rs.namespace, deploymentName), rs);
  }

  const roots: WorkloadNode[] = deployments.map((deployment) => {
    const children = (
      rsByDeployment.get(ownerKey(deployment.namespace, deployment.name)) ?? []
    ).map((rs) =>
      makeControllerNode(rs, podsByRs.get(ownerKey(rs.namespace, rs.name)) ?? [], 1, 'replicaset'),
    );
    return {
      id: `deployment:${ownerKey(deployment.namespace, deployment.name)}`,
      kind: 'deployment',
      name: deployment.name,
      namespace: deployment.namespace,
      status: `${deployment.replicas.ready}/${deployment.replicas.desired}`,
      statusTone: deployment.replicas.ready === deployment.replicas.desired ? 'ok' : 'warn',
      depth: 0,
      podCount: children.reduce((total, child) => total + (child.podCount ?? 0), 0),
      desiredReplicas: deployment.replicas.desired,
      children,
    };
  });

  for (const controller of controllers) {
    roots.push(
      makeControllerNode(
        controller,
        podsByRc.get(ownerKey(controller.namespace, controller.name)) ?? [],
        0,
        'replicationcontroller',
      ),
    );
  }

  if (unownedRs.length > 0) {
    const children = unownedRs.map((rs) =>
      makeControllerNode(rs, podsByRs.get(ownerKey(rs.namespace, rs.name)) ?? [], 1, 'replicaset'),
    );
    roots.push({
      id: UNOWNED_REPLICASETS_GROUP_ID,
      kind: 'group',
      name: 'Unowned ReplicaSets',
      statusTone: 'muted',
      depth: 0,
      podCount: children.reduce((total, child) => total + (child.podCount ?? 0), 0),
      children,
    });
  }

  if (standalonePods.length > 0) {
    const children = standalonePods.map((pod) => makePodNode(pod, 1));
    roots.push({
      id: STANDALONE_PODS_GROUP_ID,
      kind: 'group',
      name: 'Standalone pods',
      statusTone: 'muted',
      depth: 0,
      podCount: children.length,
      children,
    });
  }

  return roots;
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

interface PodContext {
  readonly pod: WorkloadNode;
  readonly replicaset?: WorkloadNode;
}

function collectPodContexts(
  nodes: readonly WorkloadNode[],
  replicaset?: WorkloadNode,
): PodContext[] {
  const contexts: PodContext[] = [];
  for (const node of nodes) {
    if (node.kind === 'pod') contexts.push({ pod: node, replicaset });
    const childAncestor = node.kind === 'replicaset' ? node : replicaset;
    if (node.children.length > 0) {
      contexts.push(...collectPodContexts(node.children, childAncestor));
    }
  }
  return contexts;
}

function rebaseDepth(node: WorkloadNode, depth: number): WorkloadNode {
  return {
    ...node,
    depth,
    children: node.children.map((child) => rebaseDepth(child, depth + 1)),
  };
}

function makeGroup(
  id: string,
  label: string,
  pods: readonly WorkloadNode[],
  extra?: { readonly namespace?: string; readonly node?: string },
): WorkloadNode {
  return {
    id,
    kind: 'group',
    name: label,
    ...extra,
    statusTone: 'muted',
    depth: 0,
    podCount: pods.length,
    children: pods.map((pod) => rebaseDepth(pod, 1)),
  };
}

function groupPods(
  contexts: readonly PodContext[],
  keyOf: (context: PodContext) => string,
  idOf: (key: string) => string,
  extraOf: (key: string) => { readonly namespace?: string; readonly node?: string },
): readonly WorkloadNode[] {
  const buckets = new Map<string, WorkloadNode[]>();
  for (const context of contexts) {
    pushBucketed(buckets, keyOf(context), context.pod);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, pods]) => makeGroup(idOf(key), key, pods, extraOf(key)));
}

/**
 * Re-root the workload tree. `deployment` keeps the Deployment → ReplicaSet →
 * Pod tree; `replicaset` promotes every ReplicaSet (owned or not) to a root;
 * `pod` flattens to pods; `namespace`/`node` group the pods under a synthetic
 * group node.
 */
export function groupBy(nodes: readonly WorkloadNode[], mode: GroupBy): readonly WorkloadNode[] {
  if (mode === 'deployment') return nodes;

  const contexts = collectPodContexts(nodes);

  if (mode === 'pod') {
    return contexts.map((context) => rebaseDepth(context.pod, 0));
  }

  if (mode === 'replicaset') {
    const replicasets = new Map<string, { node: WorkloadNode; pods: WorkloadNode[] }>();
    const standalone: WorkloadNode[] = [];
    for (const context of contexts) {
      if (context.replicaset === undefined) {
        standalone.push(context.pod);
        continue;
      }
      const entry = replicasets.get(context.replicaset.id);
      if (entry) entry.pods.push(context.pod);
      else
        replicasets.set(context.replicaset.id, { node: context.replicaset, pods: [context.pod] });
    }
    const roots: WorkloadNode[] = [...replicasets.values()].map(({ node, pods }) => ({
      ...node,
      depth: 0,
      podCount: pods.length,
      children: pods.map((pod) => rebaseDepth(pod, 1)),
    }));
    if (standalone.length > 0) {
      roots.push(makeGroup(STANDALONE_PODS_GROUP_ID, 'Standalone pods', standalone));
    }
    return roots;
  }

  if (mode === 'namespace') {
    return groupPods(
      contexts,
      (context) => context.pod.namespace ?? '',
      (key) => `group:namespace:${key}`,
      (key) => ({ namespace: key }),
    );
  }

  return groupPods(
    contexts,
    (context) => context.pod.node ?? UNSCHEDULED_NODE,
    (key) => `group:node:${key}`,
    (key) => ({ node: key }),
  );
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

/** Case-insensitive filter that keeps the ancestors of every match. */
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
