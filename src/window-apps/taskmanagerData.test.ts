import { describe, expect, it } from 'vitest';
import type {
  DeploymentInfo,
  PodInfo,
  PodMetrics,
  ReplicaCounts,
  ReplicaSetInfo,
  ReplicationControllerInfo,
} from '../cluster/client';
import {
  STANDALONE_PODS_GROUP_ID,
  UNOWNED_REPLICASETS_GROUP_ID,
  buildWorkloadTree,
  filterNodes,
  groupBy,
  indexPodMetrics,
  mergeSeries,
  rollupMetrics,
  sortNodes,
} from './taskmanagerData';
import type { SeriesSample, WorkloadNode } from './taskmanagerTypes';

function replicas(ready: number, desired = ready): ReplicaCounts {
  return { desired, ready, available: ready, updated: desired };
}

function deployment(name: string, namespace = 'default', counts = replicas(3)): DeploymentInfo {
  return { name, namespace, replicas: counts, images: [`${name}:latest`] };
}

function replicaSet(
  name: string,
  namespace = 'default',
  counts = replicas(3),
  owner?: { kind: string; name: string },
): ReplicaSetInfo {
  return { name, namespace, replicas: counts, ownerKind: owner?.kind, ownerName: owner?.name };
}

function controller(
  name: string,
  namespace = 'default',
  counts = replicas(1),
): ReplicationControllerInfo {
  return { name, namespace, replicas: counts };
}

function pod(name: string, extra: Partial<PodInfo> = {}, namespace = 'default'): PodInfo {
  return { name, namespace, phase: 'Running', ...extra };
}

function node(
  overrides: Partial<WorkloadNode> & Pick<WorkloadNode, 'id' | 'kind' | 'name' | 'depth'>,
): WorkloadNode {
  return { children: [], statusTone: 'muted', ...overrides };
}

describe('buildWorkloadTree', () => {
  const web = deployment('web', 'default', replicas(3));
  const ownedRs = replicaSet('web-7d9f', 'default', replicas(3), {
    kind: 'Deployment',
    name: 'web',
  });
  const unownedRs = replicaSet('legacy-abc', 'default', replicas(0, 1));
  const rc = controller('rc-legacy');
  const ownedPod = pod('web-7d9f-aaaaa', {
    ownerKind: 'ReplicaSet',
    ownerName: 'web-7d9f',
    node: 'n1',
  });
  const orphanPod = pod('debug', { node: 'n2', phase: 'Pending' });
  const statefulPod = pod('db-0', { ownerKind: 'StatefulSet', ownerName: 'db', node: 'n1' });
  const rcPod = pod('rc-legacy-zzz', {
    ownerKind: 'ReplicationController',
    ownerName: 'rc-legacy',
  });

  const roots = buildWorkloadTree(
    [web],
    [ownedRs, unownedRs],
    [rc],
    [ownedPod, orphanPod, statefulPod, rcPod],
  );

  it('nests Deployment → ReplicaSet → Pod at depths 0/1/2', () => {
    const [deploymentNode] = roots;
    expect(deploymentNode.kind).toBe('deployment');
    expect(deploymentNode.name).toBe('web');
    expect(deploymentNode.depth).toBe(0);
    expect(deploymentNode.status).toBe('3/3');
    expect(deploymentNode.podCount).toBe(1);

    const [rsNode] = deploymentNode.children;
    expect(rsNode.kind).toBe('replicaset');
    expect(rsNode.name).toBe('web-7d9f');
    expect(rsNode.depth).toBe(1);

    const [podNode] = rsNode.children;
    expect(podNode.kind).toBe('pod');
    expect(podNode.name).toBe('web-7d9f-aaaaa');
    expect(podNode.depth).toBe(2);
    expect(podNode.node).toBe('n1');
    expect(podNode.podCount).toBe(1);
  });

  it('attaches owned pods from the name-minus-last-hash fallback', () => {
    const fallbackPod = pod('web-7d9f-bbbbb');
    const tree = buildWorkloadTree([web], [ownedRs], [], [fallbackPod]);
    const [rsNode] = tree[0].children;
    expect(rsNode.children.map((child) => child.name)).toEqual(['web-7d9f-bbbbb']);
  });

  it('matches a ReplicaSet without an owner reference by its name prefix', () => {
    const inferred = replicaSet('web-1a2b3c', 'default', replicas(1));
    const tree = buildWorkloadTree([web], [inferred], [], []);
    expect(tree).toHaveLength(1);
    const [rsNode] = tree[0].children;
    expect(rsNode.name).toBe('web-1a2b3c');
  });

  it('collects ReplicaSets with no Deployment under "Unowned ReplicaSets"', () => {
    const group = roots.find((root) => root.id === UNOWNED_REPLICASETS_GROUP_ID);
    expect(group?.name).toBe('Unowned ReplicaSets');
    expect(group?.kind).toBe('group');
    expect(group?.depth).toBe(0);
    expect(group?.children.map((child) => child.name)).toEqual(['legacy-abc']);
    expect(group?.children[0].depth).toBe(1);
    expect(group?.children[0].status).toBe('0/1');
    expect(group?.children[0].statusTone).toBe('warn');
  });

  it('collects orphan and foreign-owned pods under "Standalone pods"', () => {
    const group = roots.find((root) => root.id === STANDALONE_PODS_GROUP_ID);
    expect(group?.name).toBe('Standalone pods');
    expect(group?.kind).toBe('group');
    expect(group?.children.map((child) => child.name)).toEqual(['debug', 'db-0']);
    expect(group?.children.every((child) => child.depth === 1)).toBe(true);
    expect(group?.podCount).toBe(2);
  });

  it('adds ReplicationControllers as top-level controllers with their pods', () => {
    const controllerNode = roots.find(
      (root) => root.id === 'replicationcontroller:default/rc-legacy',
    );
    expect(controllerNode?.kind).toBe('replicaset');
    expect(controllerNode?.depth).toBe(0);
    expect(controllerNode?.children.map((child) => child.name)).toEqual(['rc-legacy-zzz']);
    expect(controllerNode?.children[0].depth).toBe(1);
  });

  it('returns no roots for empty input', () => {
    expect(buildWorkloadTree([], [], [], [])).toEqual([]);
  });

  it('does not mutate its inputs', () => {
    const before = JSON.stringify([web, ownedRs, unownedRs, rc, ownedPod, orphanPod]);
    buildWorkloadTree([web], [ownedRs, unownedRs], [rc], [ownedPod, orphanPod]);
    expect(JSON.stringify([web, ownedRs, unownedRs, rc, ownedPod, orphanPod])).toBe(before);
  });
});

describe('rollupMetrics', () => {
  const leaf = (id: string, cpu: number, memory: number): WorkloadNode =>
    node({
      id,
      kind: 'pod',
      name: id,
      depth: 2,
      podCount: 1,
      cpuMillis: cpu,
      memoryBytes: memory,
      networkRxBytes: cpu,
      networkTxBytes: memory,
    });

  it('sums every descendant metric into each ancestor', () => {
    const tree = node({
      id: 'deployment:web',
      kind: 'deployment',
      name: 'web',
      depth: 0,
      diskCapacityBytes: 100,
      children: [
        node({
          id: 'rs:web',
          kind: 'replicaset',
          name: 'web',
          depth: 1,
          diskCapacityBytes: 500,
          children: [leaf('a', 100, 1000), leaf('b', 200, 2000)],
        }),
      ],
    });

    const rolled = rollupMetrics(tree);
    expect(rolled.cpuMillis).toBe(300);
    expect(rolled.memoryBytes).toBe(3000);
    expect(rolled.networkRxBytes).toBe(300);
    expect(rolled.podCount).toBe(2);
    expect(rolled.children[0].cpuMillis).toBe(300);
    expect(rolled.children[0].podCount).toBe(2);
    expect(rolled.diskCapacityBytes).toBe(100);
    expect(rolled.children[0].diskCapacityBytes).toBe(500);
  });

  it('leaves leaf metrics untouched', () => {
    const podNode = leaf('solo', 7, 70);
    const rolled = rollupMetrics(podNode);
    expect(rolled.cpuMillis).toBe(7);
    expect(rolled.podCount).toBe(1);
    expect(rolled).not.toBe(podNode);
    expect(rolled.children).toEqual([]);
  });

  it('returns undefined for metrics no descendant reports', () => {
    const tree = node({
      id: 'deployment:empty',
      kind: 'deployment',
      name: 'empty',
      depth: 0,
      children: [node({ id: 'rs:empty', kind: 'replicaset', name: 'empty', depth: 1 })],
    });
    const rolled = rollupMetrics(tree);
    expect(rolled.cpuMillis).toBeUndefined();
    expect(rolled.podCount).toBe(0);
  });
});

describe('indexPodMetrics', () => {
  it('keys metrics by namespace/name', () => {
    const metrics: readonly PodMetrics[] = [
      { name: 'a', namespace: 'team-a', cpuMillis: 5, memoryBytes: 50, containers: [] },
      { name: 'a', namespace: 'team-b', cpuMillis: 9, memoryBytes: 90, containers: [] },
    ];
    const index = indexPodMetrics(metrics);
    expect(index.get('team-a/a')?.cpuMillis).toBe(5);
    expect(index.get('team-b/a')?.cpuMillis).toBe(9);
    expect(index.get('team-a/b')).toBeUndefined();
    expect(index.size).toBe(2);
  });
});

describe('groupBy', () => {
  const web = deployment('web');
  const ownedRs = replicaSet('web-7d9f', 'default', replicas(2), {
    kind: 'Deployment',
    name: 'web',
  });
  const orphanA = pod('debug-a', { node: 'n2' });
  const podA = pod('web-7d9f-aaaaa', {
    ownerKind: 'ReplicaSet',
    ownerName: 'web-7d9f',
    node: 'n1',
  });
  const podB = pod('web-7d9f-bbbbb', {
    ownerKind: 'ReplicaSet',
    ownerName: 'web-7d9f',
    node: 'n2',
  });
  const tree = buildWorkloadTree([web], [ownedRs], [], [podA, podB, orphanA]);

  it('returns the tree unchanged in deployment mode', () => {
    expect(groupBy(tree, 'deployment')).toBe(tree);
  });

  it('promotes owned and unowned ReplicaSets to roots', () => {
    const roots = groupBy(tree, 'replicaset');
    expect(roots.map((root) => root.name)).toEqual(['web-7d9f', 'Standalone pods']);
    expect(roots[0].depth).toBe(0);
    expect(roots[0].kind).toBe('replicaset');
    expect(roots[0].podCount).toBe(2);
    expect(roots[0].children.map((child) => child.name)).toEqual([
      'web-7d9f-aaaaa',
      'web-7d9f-bbbbb',
    ]);
    expect(roots[0].children.every((child) => child.depth === 1)).toBe(true);
    expect(roots[1].children.map((child) => child.name)).toEqual(['debug-a']);
    expect(roots[1].children[0].depth).toBe(1);
  });

  it('flattens every pod in pod mode', () => {
    const roots = groupBy(tree, 'pod');
    expect(roots.map((root) => root.name)).toEqual(['web-7d9f-aaaaa', 'web-7d9f-bbbbb', 'debug-a']);
    expect(roots.every((root) => root.kind === 'pod' && root.depth === 0)).toBe(true);
  });

  it('groups pods by namespace', () => {
    const roots = groupBy(tree, 'namespace');
    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe('default');
    expect(roots[0].kind).toBe('group');
    expect(roots[0].namespace).toBe('default');
    expect(roots[0].children.map((child) => child.name)).toEqual([
      'web-7d9f-aaaaa',
      'web-7d9f-bbbbb',
      'debug-a',
    ]);
  });

  it('groups pods by node and falls back to Unscheduled', () => {
    const noNode = pod('floating', { ownerKind: 'ReplicaSet', ownerName: 'web-7d9f' });
    const withNode = buildWorkloadTree([web], [ownedRs], [], [podA, podB, noNode]);
    const roots = groupBy(withNode, 'node');
    const byName = new Map(roots.map((root) => [root.name, root]));
    expect([...byName.keys()].sort()).toEqual(['Unscheduled', 'n1', 'n2']);
    expect(byName.get('Unscheduled')?.node).toBe('Unscheduled');
    expect(byName.get('Unscheduled')?.children.map((child) => child.name)).toEqual(['floating']);
    expect(byName.get('n1')?.children.map((child) => child.name)).toEqual(['web-7d9f-aaaaa']);
    expect(byName.get('n2')?.children.map((child) => child.name)).toEqual(['web-7d9f-bbbbb']);
  });
});

describe('sortNodes', () => {
  const items: readonly WorkloadNode[] = [
    node({ id: 'b', kind: 'pod', name: 'beta', depth: 0, cpuMillis: 20, status: 'Running' }),
    node({ id: 'a', kind: 'pod', name: 'Alpha', depth: 0, cpuMillis: 5, status: 'Pending' }),
    node({ id: 'c', kind: 'pod', name: 'gamma', depth: 0, cpuMillis: 10, status: 'Failed' }),
  ];

  it('sorts text ascending and descending, case-insensitively', () => {
    expect(sortNodes(items, 'name', 'asc').map((item) => item.name)).toEqual([
      'Alpha',
      'beta',
      'gamma',
    ]);
    expect(sortNodes(items, 'name', 'desc').map((item) => item.name)).toEqual([
      'gamma',
      'beta',
      'Alpha',
    ]);
  });

  it('sorts numeric keys', () => {
    expect(sortNodes(items, 'cpu', 'asc').map((item) => item.cpuMillis)).toEqual([5, 10, 20]);
    expect(sortNodes(items, 'cpu', 'desc').map((item) => item.cpuMillis)).toEqual([20, 10, 5]);
  });

  it('sorts by status text', () => {
    expect(sortNodes(items, 'status', 'asc').map((item) => item.status)).toEqual([
      'Failed',
      'Pending',
      'Running',
    ]);
  });

  it('recurses into children without mutating the input', () => {
    const tree = node({
      id: 'root',
      kind: 'deployment',
      name: 'root',
      depth: 0,
      children: [
        node({ id: 'z', kind: 'pod', name: 'z', depth: 2, cpuMillis: 1 }),
        node({ id: 'a', kind: 'pod', name: 'a', depth: 2, cpuMillis: 99 }),
      ],
    });
    const sorted = sortNodes([tree], 'name', 'asc');
    expect(sorted[0].children.map((child) => child.name)).toEqual(['a', 'z']);
    expect(tree.children.map((child) => child.name)).toEqual(['z', 'a']);
  });
});

describe('filterNodes', () => {
  const tree: readonly WorkloadNode[] = [
    node({
      id: 'deployment:web',
      kind: 'deployment',
      name: 'web',
      depth: 0,
      children: [
        node({
          id: 'rs:web',
          kind: 'replicaset',
          name: 'web-1',
          depth: 1,
          children: [node({ id: 'pod:web', kind: 'pod', name: 'web-1-abcde', depth: 2 })],
        }),
      ],
    }),
    node({ id: 'deployment:api', kind: 'deployment', name: 'api', depth: 0 }),
  ];

  it('returns the same reference for a blank query', () => {
    expect(filterNodes(tree, '   ')).toBe(tree);
  });

  it('keeps ancestors of a deep match and prunes the rest', () => {
    const result = filterNodes(tree, 'ABCDE');
    expect(result.map((item) => item.name)).toEqual(['web']);
    expect(result[0].children.map((item) => item.name)).toEqual(['web-1']);
    expect(result[0].children[0].children.map((item) => item.name)).toEqual(['web-1-abcde']);
  });

  it('drops non-matching descendants of a matching parent', () => {
    const result = filterNodes(tree, 'api');
    expect(result.map((item) => item.name)).toEqual(['api']);
    expect(result[0].children).toEqual([]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterNodes(tree, 'nope')).toEqual([]);
  });
});

describe('mergeSeries', () => {
  const sample = (v: number): SeriesSample => ({ t: v, v });

  it('ignores a null sample', () => {
    const prev = [sample(1)];
    expect(mergeSeries(prev, null)).toBe(prev);
  });

  it('appends a changed value', () => {
    const next = mergeSeries([sample(1)], sample(2));
    expect(next.map((item) => item.v)).toEqual([1, 2]);
  });

  it('dedupes a repeated payload value', () => {
    const prev = [sample(1), sample(2)];
    expect(mergeSeries(prev, sample(2))).toBe(prev);
  });

  it('caps the buffer at the requested capacity', () => {
    let buffer: readonly SeriesSample[] = [];
    for (let i = 0; i < 5; i += 1) buffer = mergeSeries(buffer, sample(i), 2);
    expect(buffer.map((item) => item.v)).toEqual([3, 4]);
  });
});
