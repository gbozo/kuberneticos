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
  ownerKind?: string; // 'ReplicaSet' | 'ReplicationController' | 'StatefulSet' | ...
  ownerName?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export interface NamespaceInfo {
  name: string;
  status: string;
}

export interface ReplicaCounts {
  desired: number;
  ready: number;
  available: number;
  updated: number;
}

export interface DeploymentInfo {
  name: string;
  namespace: string;
  replicas: ReplicaCounts;
  images: readonly string[];
}

export interface ReplicaSetInfo {
  name: string;
  namespace: string;
  replicas: ReplicaCounts;
  ownerKind?: string; // 'Deployment' | ...
  ownerName?: string;
}

export interface ReplicationControllerInfo {
  name: string;
  namespace: string;
  replicas: ReplicaCounts;
}

export interface ServicePortInfo {
  name?: string;
  port: number;
  protocol: string;
  targetPort: string;
}

export interface ServiceInfo {
  name: string;
  namespace: string;
  type: string;
  clusterIP: string;
  ports: readonly ServicePortInfo[];
  readonly selector?: Readonly<Record<string, string>>;
}

export interface NodeConditionInfo {
  type: string;
  status: string;
}

export interface NodeAddressInfo {
  type: string;
  address: string;
}

export interface NodeDetailInfo {
  name: string;
  status: string;
  roles: readonly string[];
  version: string;
  capacity: Readonly<Record<string, string>>;
  allocatable: Readonly<Record<string, string>>;
  conditions: readonly NodeConditionInfo[];
  addresses: readonly NodeAddressInfo[];
}

interface ClustersResponse {
  readonly source: string;
  readonly clusters: readonly ClusterInfo[];
}

interface NodesResponse {
  readonly source: string;
  readonly nodes: readonly NodeInfo[];
}

interface NamespacesResponse {
  readonly source: string;
  readonly namespaces: readonly NamespaceInfo[];
}

interface DeploymentsResponse {
  readonly source: string;
  readonly deployments: readonly DeploymentInfo[];
}

interface ReplicaSetsResponse {
  readonly source: string;
  readonly replicasets: readonly ReplicaSetInfo[];
}

interface ReplicationControllersResponse {
  readonly source: string;
  readonly replicationcontrollers: readonly ReplicationControllerInfo[];
}

interface ServicesResponse {
  readonly source: string;
  readonly services: readonly ServiceInfo[];
}

interface NodeDetailResponse {
  readonly source: string;
  readonly node: NodeDetailInfo;
}

interface PodsResponse {
  readonly source: string;
  readonly pods: readonly PodInfo[];
}

interface PodLogsResponse {
  readonly source: string;
  readonly logs: string;
}

export interface ContainerMetrics {
  readonly name: string;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
}

export interface NodeMetrics {
  readonly name: string;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
  readonly cpuAllocatableMillis?: number;
  readonly memoryAllocatableBytes?: number;
  readonly diskUsedBytes?: number;
  readonly diskCapacityBytes?: number;
  readonly networkRxBytes?: number;
  readonly networkTxBytes?: number;
  readonly podCount?: number;
}

export interface PodMetrics {
  readonly name: string;
  readonly namespace: string;
  readonly node?: string;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
  readonly containers: readonly ContainerMetrics[];
  readonly diskUsedBytes?: number;
  readonly networkRxBytes?: number;
  readonly networkTxBytes?: number;
}

export interface NodeMetricsResult {
  readonly available: boolean;
  readonly nodes: readonly NodeMetrics[];
}

export interface PodMetricsResult {
  readonly available: boolean;
  readonly pods: readonly PodMetrics[];
}

interface NodeMetricsResponse {
  readonly source: string;
  readonly available: boolean;
  readonly nodes: readonly NodeMetrics[];
}

interface PodMetricsResponse {
  readonly source: string;
  readonly available: boolean;
  readonly pods: readonly PodMetrics[];
}

export interface ClusterClient {
  listClusters(): Promise<readonly ClusterInfo[]>;
  listNodes(clusterId: string): Promise<readonly NodeInfo[]>;
  listNamespaces(clusterId: string): Promise<readonly NamespaceInfo[]>;
  listDeployments(clusterId: string, namespace?: string): Promise<readonly DeploymentInfo[]>;
  listReplicaSets(clusterId: string, namespace?: string): Promise<readonly ReplicaSetInfo[]>;
  listReplicationControllers(
    clusterId: string,
    namespace?: string,
  ): Promise<readonly ReplicationControllerInfo[]>;
  listServices(clusterId: string, namespace?: string): Promise<readonly ServiceInfo[]>;
  listPods(
    clusterId: string,
    node?: string,
    namespace?: string,
    selector?: string,
  ): Promise<readonly PodInfo[]>;
  getNode(clusterId: string, name: string): Promise<NodeDetailInfo>;
  getPodLogs(
    clusterId: string,
    namespace: string,
    pod: string,
    container?: string,
    tailLines?: number,
  ): Promise<string>;
  getNodeMetrics(clusterId: string): Promise<NodeMetricsResult>;
  getPodMetrics(clusterId: string, namespace?: string): Promise<PodMetricsResult>;
}

export class OfflineClusterClient implements ClusterClient {
  async listClusters(): Promise<readonly ClusterInfo[]> {
    return [];
  }

  async listNodes(_clusterId: string): Promise<readonly NodeInfo[]> {
    return [];
  }

  async listNamespaces(_clusterId: string): Promise<readonly NamespaceInfo[]> {
    return [];
  }

  async listDeployments(
    _clusterId: string,
    _namespace?: string,
  ): Promise<readonly DeploymentInfo[]> {
    return [];
  }

  async listReplicaSets(
    _clusterId: string,
    _namespace?: string,
  ): Promise<readonly ReplicaSetInfo[]> {
    return [];
  }

  async listReplicationControllers(
    _clusterId: string,
    _namespace?: string,
  ): Promise<readonly ReplicationControllerInfo[]> {
    return [];
  }

  async listServices(_clusterId: string, _namespace?: string): Promise<readonly ServiceInfo[]> {
    return [];
  }

  async listPods(
    _clusterId: string,
    _node?: string,
    _namespace?: string,
    _selector?: string,
  ): Promise<readonly PodInfo[]> {
    return [];
  }

  async getNode(_clusterId: string, _name: string): Promise<NodeDetailInfo> {
    return {
      name: '',
      status: '',
      roles: [],
      version: '',
      capacity: {},
      allocatable: {},
      conditions: [],
      addresses: [],
    };
  }

  async getPodLogs(
    _clusterId: string,
    _namespace: string,
    _pod: string,
    _container?: string,
    _tailLines?: number,
  ): Promise<string> {
    return '';
  }

  async getNodeMetrics(_clusterId: string): Promise<NodeMetricsResult> {
    return { available: false, nodes: [] };
  }

  async getPodMetrics(_clusterId: string, _namespace?: string): Promise<PodMetricsResult> {
    return { available: false, pods: [] };
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

  async listNamespaces(clusterId: string): Promise<readonly NamespaceInfo[]> {
    const params = new URLSearchParams({ cluster: clusterId });
    const envelope = await requestJson<NamespacesResponse>(
      `${this.baseUrl}/namespaces?${params.toString()}`,
    );
    return envelope.namespaces;
  }

  async listDeployments(clusterId: string, namespace?: string): Promise<readonly DeploymentInfo[]> {
    const params = new URLSearchParams({ cluster: clusterId });
    if (namespace !== undefined && namespace !== '') params.set('namespace', namespace);
    const envelope = await requestJson<DeploymentsResponse>(
      `${this.baseUrl}/deployments?${params.toString()}`,
    );
    return envelope.deployments;
  }

  async listReplicaSets(clusterId: string, namespace?: string): Promise<readonly ReplicaSetInfo[]> {
    const params = new URLSearchParams({ cluster: clusterId });
    if (namespace !== undefined && namespace !== '') params.set('namespace', namespace);
    const envelope = await requestJson<ReplicaSetsResponse>(
      `${this.baseUrl}/replicasets?${params.toString()}`,
    );
    return envelope.replicasets;
  }

  async listReplicationControllers(
    clusterId: string,
    namespace?: string,
  ): Promise<readonly ReplicationControllerInfo[]> {
    const params = new URLSearchParams({ cluster: clusterId });
    if (namespace !== undefined && namespace !== '') params.set('namespace', namespace);
    const envelope = await requestJson<ReplicationControllersResponse>(
      `${this.baseUrl}/replicationcontrollers?${params.toString()}`,
    );
    return envelope.replicationcontrollers;
  }

  async listServices(clusterId: string, namespace?: string): Promise<readonly ServiceInfo[]> {
    const params = new URLSearchParams({ cluster: clusterId });
    if (namespace !== undefined && namespace !== '') params.set('namespace', namespace);
    const envelope = await requestJson<ServicesResponse>(
      `${this.baseUrl}/services?${params.toString()}`,
    );
    return envelope.services;
  }

  async listPods(
    clusterId: string,
    node?: string,
    namespace?: string,
    selector?: string,
  ): Promise<readonly PodInfo[]> {
    const params = new URLSearchParams({ cluster: clusterId });
    if (node !== undefined && node !== '') params.set('node', node);
    if (namespace !== undefined && namespace !== '') params.set('namespace', namespace);
    if (selector !== undefined && selector !== '') params.set('selector', selector);
    const envelope = await requestJson<PodsResponse>(`${this.baseUrl}/pods?${params.toString()}`);
    return envelope.pods;
  }

  async getNode(clusterId: string, name: string): Promise<NodeDetailInfo> {
    const params = new URLSearchParams({ cluster: clusterId, name });
    const envelope = await requestJson<NodeDetailResponse>(
      `${this.baseUrl}/nodes/detail?${params.toString()}`,
    );
    return envelope.node;
  }

  async getPodLogs(
    clusterId: string,
    namespace: string,
    pod: string,
    container?: string,
    tailLines?: number,
  ): Promise<string> {
    const params = new URLSearchParams({ cluster: clusterId, namespace, pod });
    if (container !== undefined && container !== '') params.set('container', container);
    if (tailLines !== undefined) params.set('tailLines', String(tailLines));
    const envelope = await requestJson<PodLogsResponse>(
      `${this.baseUrl}/pods/logs?${params.toString()}`,
    );
    return envelope.logs;
  }

  async getNodeMetrics(clusterId: string): Promise<NodeMetricsResult> {
    const params = new URLSearchParams({ cluster: clusterId });
    const envelope = await requestJson<NodeMetricsResponse>(
      `${this.baseUrl}/metrics/nodes?${params.toString()}`,
    );
    return { available: envelope.available, nodes: envelope.nodes };
  }

  async getPodMetrics(clusterId: string, namespace?: string): Promise<PodMetricsResult> {
    const params = new URLSearchParams({ cluster: clusterId });
    if (namespace !== undefined && namespace !== '') params.set('namespace', namespace);
    const envelope = await requestJson<PodMetricsResponse>(
      `${this.baseUrl}/metrics/pods?${params.toString()}`,
    );
    return { available: envelope.available, pods: envelope.pods };
  }
}

// The frontend talks to the Go server through the Vite-proxied `/api` base path.
export function createClusterClient(): ClusterClient {
  return new HttpClusterClient();
}

export const clusterClient: ClusterClient = createClusterClient();
