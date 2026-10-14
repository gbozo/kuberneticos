// Shared Task Manager 2.0 types (Phase 0 — frozen for later phases). See tasks.md §6 P0-D.

export type TaskManagerPage =
  'workloads' | 'performance' | 'services' | 'pods' | 'namespaces' | 'nodes' | 'settings';

export const DEFAULT_TASK_MANAGER_PAGE: TaskManagerPage = 'workloads';

export type UpdateSpeed = 'paused' | 'low' | 'normal' | 'high';

export const DEFAULT_UPDATE_SPEED: UpdateSpeed = 'normal';

export type GroupBy = 'deployment' | 'replicaset' | 'pod' | 'namespace' | 'node';

/** `null` means "all namespaces". */
export type NamespaceFilter = string | null;

export type WorkloadKind = 'deployment' | 'replicaset' | 'pod';

export type StatusTone = 'ok' | 'warn' | 'danger' | 'muted';

export interface WorkloadNode {
  readonly id: string;
  readonly kind: WorkloadKind;
  readonly name: string;
  readonly namespace?: string;
  readonly status?: string;
  readonly statusTone?: StatusTone;
  readonly depth: number;
  readonly cpuMillis?: number;
  readonly memoryBytes?: number;
  readonly diskUsedBytes?: number;
  readonly diskCapacityBytes?: number;
  readonly networkRxBytes?: number;
  readonly networkTxBytes?: number;
  readonly podCount?: number;
  readonly children: readonly WorkloadNode[];
}

export interface SeriesSample {
  /** Sample timestamp (epoch milliseconds). */
  readonly t: number;
  readonly v: number;
}

export interface MetricSeries {
  readonly key: string;
  readonly label: string;
  readonly color?: string;
  readonly samples: readonly SeriesSample[];
}

/** Common props handed to every page view by the shell (G1). */
export interface TaskManagerViewProps {
  readonly clusterId?: string;
  readonly namespace?: NamespaceFilter;
  readonly updateSpeed: UpdateSpeed;
}

/** Inventory pages (Pods/Namespaces/Nodes/Settings) share one component. */
export interface TaskManagerInventoryProps extends TaskManagerViewProps {
  readonly page: Extract<TaskManagerPage, 'pods' | 'namespaces' | 'nodes' | 'settings'>;
}
