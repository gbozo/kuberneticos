export interface ClusterInfo {
  id: string;
  name: string;
  server: string;
}

export interface NodeInfo {
  name: string;
  status: 'Ready' | 'NotReady' | 'Unknown';
  roles: readonly string[];
  version?: string;
}

export interface PodInfo {
  name: string;
  namespace: string;
  node?: string;
  phase: string;
}

interface ClustersResponse {
  readonly source: string;
  readonly clusters: readonly ClusterInfo[];
}

interface NodesResponse {
  readonly source: string;
  readonly nodes: readonly NodeInfo[];
}

interface PodsResponse {
  readonly source: string;
  readonly pods: readonly PodInfo[];
}

export interface ClusterClient {
  listClusters(): Promise<readonly ClusterInfo[]>;
  listNodes(clusterId: string): Promise<readonly NodeInfo[]>;
  listPods(clusterId: string, node?: string, namespace?: string): Promise<readonly PodInfo[]>;
}

export class OfflineClusterClient implements ClusterClient {
  async listClusters(): Promise<readonly ClusterInfo[]> {
    return [];
  }

  async listNodes(_clusterId: string): Promise<readonly NodeInfo[]> {
    return [];
  }

  async listPods(
    _clusterId: string,
    _node?: string,
    _namespace?: string,
  ): Promise<readonly PodInfo[]> {
    return [];
  }
}

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Cluster API request failed: ${response.status} ${response.statusText} (${url})`,
    );
  }
  return (await response.json()) as T;
}

export class HttpClusterClient implements ClusterClient {
  private readonly baseUrl: string;

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async listClusters(): Promise<readonly ClusterInfo[]> {
    const envelope = await requestJson<ClustersResponse>(`${this.baseUrl}/clusters`);
    return envelope.clusters;
  }

  async listNodes(clusterId: string): Promise<readonly NodeInfo[]> {
    const params = new URLSearchParams({ cluster: clusterId });
    const envelope = await requestJson<NodesResponse>(`${this.baseUrl}/nodes?${params.toString()}`);
    return envelope.nodes;
  }

  async listPods(
    clusterId: string,
    node?: string,
    namespace?: string,
  ): Promise<readonly PodInfo[]> {
    const params = new URLSearchParams({ cluster: clusterId });
    if (node !== undefined) params.set('node', node);
    if (namespace !== undefined) params.set('namespace', namespace);
    const envelope = await requestJson<PodsResponse>(`${this.baseUrl}/pods?${params.toString()}`);
    return envelope.pods;
  }
}

// The frontend talks to the Go server through the Vite-proxied `/api` base path.
export function createClusterClient(): ClusterClient {
  return new HttpClusterClient();
}

export const clusterClient: ClusterClient = createClusterClient();
