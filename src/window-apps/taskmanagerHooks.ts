// Task Manager 2.0 hooks (D2).
// Poll cadence follows the update speed — Normal = 2s poll / 15s data (tasks.md §11.4).
import { useCallback, useEffect, useRef, useState } from 'react';
import { clusterClient } from '../cluster/client';
import type { NodeMetrics, PodMetrics } from '../cluster/client';
import { mergeSeries } from './taskmanagerData';
import type { SeriesSample, UpdateSpeed } from './taskmanagerTypes';

/** Poll interval in milliseconds per update speed. `paused` disables polling. */
export const UPDATE_SPEED_INTERVAL_MS: Readonly<Record<UpdateSpeed, number>> = {
  paused: 0,
  low: 5000,
  normal: 2000,
  high: 1000,
};

export interface PolledMetricsOptions {
  readonly clusterId?: string;
  readonly namespace?: string;
  readonly updateSpeed: UpdateSpeed;
}

export interface PolledMetricsState {
  readonly nodes: readonly NodeMetrics[];
  readonly pods: readonly PodMetrics[];
  readonly available: boolean;
  readonly error: string | null;
  readonly lastUpdated: number | null;
  readonly refresh: () => void;
}

export type UsePolledMetrics = (options: PolledMetricsOptions) => PolledMetricsState;

/** Poll node + pod metrics for the selected cluster at the configured update speed. */
export function usePolledMetrics(options: PolledMetricsOptions): PolledMetricsState {
  const { clusterId, namespace, updateSpeed } = options;
  const [nodes, setNodes] = useState<readonly NodeMetrics[]>([]);
  const [pods, setPods] = useState<readonly PodMetrics[]>([]);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (clusterId === undefined || clusterId === '') {
      setNodes([]);
      setPods([]);
      setAvailable(false);
      return;
    }
    try {
      const [nodeResult, podResult] = await Promise.all([
        clusterClient.getNodeMetrics(clusterId),
        clusterClient.getPodMetrics(clusterId, namespace),
      ]);
      if (!mounted.current) return;
      setNodes(nodeResult.nodes);
      setPods(podResult.pods);
      setAvailable(nodeResult.available || podResult.available);
      setError(null);
      setLastUpdated(Date.now());
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [clusterId, namespace]);

  useEffect(() => {
    void load();
    const intervalMs = UPDATE_SPEED_INTERVAL_MS[updateSpeed];
    if (intervalMs <= 0) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void load();
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [load, updateSpeed]);

  return { nodes, pods, available, error, lastUpdated, refresh: load };
}

/** Rolling sample buffer honouring the append-only-on-change dedupe rule. */
export function useSeriesBuffer(sample: number | null, capacity = 60): readonly SeriesSample[] {
  const [buffer, setBuffer] = useState<readonly SeriesSample[]>([]);
  useEffect(() => {
    if (sample === null) return;
    setBuffer((prev) => mergeSeries(prev, { t: Date.now(), v: sample }, capacity));
  }, [sample, capacity]);
  return buffer;
}

/** `localStorage`-backed preference with JSON parsing and error handling. */
export function useLocalPref<T>(key: string, initial: T): readonly [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next: T): void => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Ignore write failures (private mode / quota).
      }
    },
    [key],
  );

  return [value, update];
}

// Re-export mergeSeries for convenience
export { mergeSeries } from './taskmanagerData';
