import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClusterClient, OfflineClusterClient, createClusterClient } from './client';
import type {
  ClusterInfo,
  DeploymentInfo,
  NamespaceInfo,
  NodeDetailInfo,
  NodeInfo,
  PodInfo,
  ReplicaSetInfo,
  ReplicationControllerInfo,
  ServiceInfo,
} from './client';

type FetchMock = ReturnType<
  typeof vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>
>;

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  } as Response;
}

function stubFetch(payload: unknown): FetchMock {
  const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
  fetchMock.mockResolvedValue(jsonResponse(payload));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestedUrl(fetchMock: FetchMock): URL {
  return new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost');
}

const clusters: readonly ClusterInfo[] = [{ id: 'a', name: 'A', server: 'https://a.example' }];
const nodes: readonly NodeInfo[] = [{ name: 'n1', status: 'Ready', roles: [], version: 'v1' }];
const pods: readonly PodInfo[] = [
  { name: 'p1', namespace: 'default', node: 'n1', phase: 'Running' },
];
const namespaces: readonly NamespaceInfo[] = [{ name: 'default', status: 'Active' }];
const deployments: readonly DeploymentInfo[] = [
  {
    name: 'web',
    namespace: 'team-a',
    replicas: { desired: 3, ready: 2, available: 2, updated: 3 },
    images: ['nginx:1.27'],
  },
];
const replicaSets: readonly ReplicaSetInfo[] = [
  {
    name: 'web-abc',
    namespace: 'team-a',
    replicas: { desired: 3, ready: 2, available: 2, updated: 3 },
  },
];
const replicationControllers: readonly ReplicationControllerInfo[] = [
  {
    name: 'legacy',
    namespace: 'team-a',
    replicas: { desired: 1, ready: 1, available: 1, updated: 1 },
  },
];
const services: readonly ServiceInfo[] = [
  {
    name: 'web',
    namespace: 'team-a',
    type: 'ClusterIP',
    clusterIP: '10.0.0.1',
    ports: [{ port: 80, protocol: 'TCP', targetPort: '8080' }],
  },
];
const nodeDetail: NodeDetailInfo = {
  name: 'n1',
  status: 'Ready',
  roles: ['control-plane'],
  version: 'v1.30.0',
  capacity: { cpu: '4' },
  allocatable: { cpu: '4' },
  conditions: [{ type: 'Ready', status: 'True' }],
  addresses: [{ type: 'InternalIP', address: '10.0.0.10' }],
};

describe('HttpClusterClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches /api/clusters and unwraps the clusters envelope', async () => {
    const fetchMock = stubFetch({ source: 'go', clusters });
    const client = new HttpClusterClient();

    const result = await client.listClusters();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(clusters);
    const url = requestedUrl(fetchMock);
    expect(url.pathname.endsWith('/api/clusters')).toBe(true);
  });

  it('fetches /api/nodes?cluster=abc and unwraps the nodes envelope', async () => {
    const fetchMock = stubFetch({ source: 'go', nodes });
    const client = new HttpClusterClient();

    const result = await client.listNodes('abc');

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(nodes);
    const url = requestedUrl(fetchMock);
    expect(`${url.pathname}${url.search}`).toBe('/api/nodes?cluster=abc');
  });

  it('fetches /api/pods?cluster=abc without node or namespace when omitted', async () => {
    const fetchMock = stubFetch({ source: 'go', pods });
    const client = new HttpClusterClient();

    const result = await client.listPods('abc');

    expect(result).toEqual(pods);
    const url = requestedUrl(fetchMock);
    expect(`${url.pathname}${url.search}`).toBe('/api/pods?cluster=abc');
    expect(url.searchParams.has('node')).toBe(false);
    expect(url.searchParams.has('namespace')).toBe(false);
  });

  it('forwards the node and namespace pod filters', async () => {
    const fetchMock = stubFetch({ source: 'go', pods });
    const client = new HttpClusterClient();

    await client.listPods('abc', 'n1', 'kube-system');

    const url = requestedUrl(fetchMock);
    expect(url.pathname.endsWith('/api/pods')).toBe(true);
    const params = new URLSearchParams(url.search);
    expect(params.get('cluster')).toBe('abc');
    expect(params.get('node')).toBe('n1');
    expect(params.get('namespace')).toBe('kube-system');
  });

  it('forwards the pod selector filter', async () => {
    const fetchMock = stubFetch({ source: 'go', pods });
    const client = new HttpClusterClient();

    await client.listPods('abc', undefined, undefined, 'app=web');

    const url = requestedUrl(fetchMock);
    expect(`${url.pathname}${url.search}`).toBe('/api/pods?cluster=abc&selector=app%3Dweb');
    expect(url.searchParams.get('selector')).toBe('app=web');
    expect(url.searchParams.has('node')).toBe(false);
    expect(url.searchParams.has('namespace')).toBe(false);
  });

  it('fetches /api/namespaces?cluster=abc and unwraps the namespaces envelope', async () => {
    const fetchMock = stubFetch({ source: 'go', namespaces });
    const client = new HttpClusterClient();

    const result = await client.listNamespaces('abc');

    expect(result).toEqual(namespaces);
    const url = requestedUrl(fetchMock);
    expect(`${url.pathname}${url.search}`).toBe('/api/namespaces?cluster=abc');
  });

  it('fetches /api/deployments?cluster=abc&namespace=team-a and unwraps the envelope', async () => {
    const fetchMock = stubFetch({ source: 'go', deployments });
    const client = new HttpClusterClient();

    const result = await client.listDeployments('abc', 'team-a');

    expect(result).toEqual(deployments);
    const url = requestedUrl(fetchMock);
    expect(`${url.pathname}${url.search}`).toBe('/api/deployments?cluster=abc&namespace=team-a');
  });

  it('fetches /api/replicasets without a namespace when omitted', async () => {
    const fetchMock = stubFetch({ source: 'go', replicasets: replicaSets });
    const client = new HttpClusterClient();

    const result = await client.listReplicaSets('abc');

    expect(result).toEqual(replicaSets);
    const url = requestedUrl(fetchMock);
    expect(`${url.pathname}${url.search}`).toBe('/api/replicasets?cluster=abc');
    expect(url.searchParams.has('namespace')).toBe(false);
  });

  it('fetches /api/replicationcontrollers and unwraps the envelope', async () => {
    const fetchMock = stubFetch({ source: 'go', replicationcontrollers: replicationControllers });
    const client = new HttpClusterClient();

    const result = await client.listReplicationControllers('abc', 'team-a');

    expect(result).toEqual(replicationControllers);
    const url = requestedUrl(fetchMock);
    expect(`${url.pathname}${url.search}`).toBe(
      '/api/replicationcontrollers?cluster=abc&namespace=team-a',
    );
  });

  it('fetches /api/services?cluster=abc&namespace=team-a and unwraps the envelope', async () => {
    const fetchMock = stubFetch({ source: 'go', services });
    const client = new HttpClusterClient();

    const result = await client.listServices('abc', 'team-a');

    expect(result).toEqual(services);
    const url = requestedUrl(fetchMock);
    expect(`${url.pathname}${url.search}`).toBe('/api/services?cluster=abc&namespace=team-a');
  });

  it('fetches /api/nodes/detail?cluster=abc&name=n1 and unwraps the node object', async () => {
    const fetchMock = stubFetch({ source: 'go', node: nodeDetail });
    const client = new HttpClusterClient();

    const result = await client.getNode('abc', 'n1');

    expect(result).toEqual(nodeDetail);
    const url = requestedUrl(fetchMock);
    expect(`${url.pathname}${url.search}`).toBe('/api/nodes/detail?cluster=abc&name=n1');
  });

  it('fetches /api/pods/logs with pod and tailLines and resolves the logs string', async () => {
    const fetchMock = stubFetch({ source: 'go', logs: 'hello\nworld' });
    const client = new HttpClusterClient();

    const result = await client.getPodLogs('abc', 'default', 'p1', undefined, 200);

    expect(typeof result).toBe('string');
    expect(result).toBe('hello\nworld');
    const url = requestedUrl(fetchMock);
    const params = new URLSearchParams(url.search);
    expect(url.pathname.endsWith('/api/pods/logs')).toBe(true);
    expect(params.get('cluster')).toBe('abc');
    expect(params.get('namespace')).toBe('default');
    expect(params.get('pod')).toBe('p1');
    expect(params.get('tailLines')).toBe('200');
    expect(params.has('container')).toBe(false);
  });

  it('forwards the pod log container when provided', async () => {
    const fetchMock = stubFetch({ source: 'go', logs: '' });
    const client = new HttpClusterClient();

    await client.getPodLogs('abc', 'default', 'p1', 'web');

    const url = requestedUrl(fetchMock);
    expect(url.searchParams.get('container')).toBe('web');
    expect(url.searchParams.has('tailLines')).toBe(false);
  });

  it('fetches /api/metrics/nodes and unwraps the metrics envelope', async () => {
    const nodes = [{ name: 'n1', cpuMillis: 73, memoryBytes: 1054204 * 1024 }];
    const fetchMock = stubFetch({ source: 'go', available: true, nodes });
    const client = new HttpClusterClient();

    const result = await client.getNodeMetrics('abc');

    expect(result).toEqual({ available: true, nodes });
    const url = requestedUrl(fetchMock);
    expect(`${url.pathname}${url.search}`).toBe('/api/metrics/nodes?cluster=abc');
  });

  it('fetches /api/metrics/pods with optional namespace', async () => {
    const pods = [
      {
        name: 'p1',
        namespace: 'default',
        cpuMillis: 10,
        memoryBytes: 512 * 1024,
        containers: [],
      },
    ];
    const fetchMock1 = stubFetch({ source: 'go', available: true, pods });
    const client = new HttpClusterClient();

    const res1 = await client.getPodMetrics('abc');
    expect(res1).toEqual({ available: true, pods });
    expect(`${requestedUrl(fetchMock1).pathname}${requestedUrl(fetchMock1).search}`).toBe(
      '/api/metrics/pods?cluster=abc',
    );

    const fetchMock2 = stubFetch({ source: 'go', available: true, pods });
    const client2 = new HttpClusterClient();
    const res2 = await client2.getPodMetrics('abc', 'default');
    expect(res2).toEqual({ available: true, pods });
    const url2 = requestedUrl(fetchMock2);
    expect(`${url2.pathname}${url2.search}`).toBe(
      '/api/metrics/pods?cluster=abc&namespace=default',
    );
  });

  it('rejects with the status when the response is not ok', async () => {
    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const client = new HttpClusterClient();

    await expect(client.listClusters()).rejects.toThrow(/500/);
  });
});

describe('OfflineClusterClient', () => {
  it('returns empty arrays from all three methods', async () => {
    const client = new OfflineClusterClient();

    await expect(client.listClusters()).resolves.toEqual([]);
    await expect(client.listNodes('abc')).resolves.toEqual([]);
    await expect(client.listPods('abc')).resolves.toEqual([]);
  });

  it('returns empty arrays from every list method', async () => {
    const client = new OfflineClusterClient();

    await expect(client.listNamespaces('abc')).resolves.toEqual([]);
    await expect(client.listDeployments('abc', 'default')).resolves.toEqual([]);
    await expect(client.listReplicaSets('abc', 'default')).resolves.toEqual([]);
    await expect(client.listReplicationControllers('abc', 'default')).resolves.toEqual([]);
    await expect(client.listServices('abc', 'default')).resolves.toEqual([]);
  });

  it('returns an empty-safe NodeDetailInfo from getNode', async () => {
    const client = new OfflineClusterClient();

    const node = await client.getNode('abc', 'n1');

    expect(node).toEqual({
      name: '',
      status: '',
      roles: [],
      version: '',
      capacity: {},
      allocatable: {},
      conditions: [],
      addresses: [],
    });
    expect(node.capacity).not.toBeUndefined();
    expect(node.allocatable).not.toBeUndefined();
  });

  it('resolves to an empty string from getPodLogs', async () => {
    const client = new OfflineClusterClient();

    await expect(client.getPodLogs('abc', 'default', 'p1')).resolves.toBe('');
  });

  it('returns available:false with empty arrays from metrics methods', async () => {
    const client = new OfflineClusterClient();
    await expect(client.getNodeMetrics('abc')).resolves.toEqual({ available: false, nodes: [] });
    await expect(client.getPodMetrics('abc')).resolves.toEqual({ available: false, pods: [] });
    await expect(client.getPodMetrics('abc', 'default')).resolves.toEqual({
      available: false,
      pods: [],
    });
  });
});

describe('createClusterClient', () => {
  it('returns an HttpClusterClient', () => {
    expect(createClusterClient()).toBeInstanceOf(HttpClusterClient);
  });
});
