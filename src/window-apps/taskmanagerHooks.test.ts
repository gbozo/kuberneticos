import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clusterClient } from '../cluster/client';
import type {
  NodeMetrics,
  NodeMetricsResult,
  PodMetrics,
  PodMetricsResult,
} from '../cluster/client';
import {
  UPDATE_SPEED_INTERVAL_MS,
  useLocalPref,
  usePolledMetrics,
  useSeriesBuffer,
} from './taskmanagerHooks';
import type { UpdateSpeed } from './taskmanagerTypes';

vi.mock('../cluster/client', () => ({
  clusterClient: { getNodeMetrics: vi.fn(), getPodMetrics: vi.fn() },
}));

const getNodeMetrics = vi.mocked(clusterClient.getNodeMetrics);
const getPodMetrics = vi.mocked(clusterClient.getPodMetrics);

const nodeA: NodeMetrics = { name: 'node-a', cpuMillis: 250, memoryBytes: 1024 };
const podA: PodMetrics = {
  name: 'pod-a',
  namespace: 'default',
  cpuMillis: 10,
  memoryBytes: 256,
  containers: [],
};

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  if (vi.isFakeTimers()) vi.useRealTimers();
  Reflect.deleteProperty(document, 'hidden');
  window.localStorage.clear();
});

describe('UPDATE_SPEED_INTERVAL_MS', () => {
  it('maps each update speed to its poll interval', () => {
    expect(UPDATE_SPEED_INTERVAL_MS).toEqual({ paused: 0, low: 5000, normal: 2000, high: 1000 });
  });
});

describe('usePolledMetrics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('loads once initially and polls again after the normal interval', async () => {
    getNodeMetrics.mockResolvedValue({ available: true, nodes: [nodeA] });
    getPodMetrics.mockResolvedValue({ available: true, pods: [podA] });

    const { result } = renderHook(() =>
      usePolledMetrics({ clusterId: 'prod', namespace: 'default', updateSpeed: 'normal' }),
    );
    await advance(0);

    expect(getNodeMetrics).toHaveBeenCalledTimes(1);
    expect(getNodeMetrics).toHaveBeenCalledWith('prod');
    expect(getPodMetrics).toHaveBeenCalledTimes(1);
    expect(getPodMetrics).toHaveBeenCalledWith('prod', 'default');

    expect(result.current.nodes).toEqual([nodeA]);
    expect(result.current.pods).toEqual([podA]);
    expect(result.current.available).toBe(true);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.lastUpdated).toBe('number');

    await advance(1999);
    expect(getNodeMetrics).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(getNodeMetrics).toHaveBeenCalledTimes(2);
    expect(getPodMetrics).toHaveBeenCalledTimes(2);
  });

  it('does not poll again while paused', async () => {
    getNodeMetrics.mockResolvedValue({ available: true, nodes: [] });
    getPodMetrics.mockResolvedValue({ available: true, pods: [] });

    renderHook(() => usePolledMetrics({ clusterId: 'prod', updateSpeed: 'paused' }));
    await advance(0);
    expect(getNodeMetrics).toHaveBeenCalledTimes(1);

    await advance(20000);
    expect(getNodeMetrics).toHaveBeenCalledTimes(1);
    expect(getPodMetrics).toHaveBeenCalledTimes(1);
  });

  it('skips overlapping polls while a request is in flight', async () => {
    const nodeDeferreds: Array<(value: NodeMetricsResult) => void> = [];
    const podDeferreds: Array<(value: PodMetricsResult) => void> = [];
    getNodeMetrics.mockImplementation(
      () =>
        new Promise<NodeMetricsResult>((resolve) => {
          nodeDeferreds.push(resolve);
        }),
    );
    getPodMetrics.mockImplementation(
      () =>
        new Promise<PodMetricsResult>((resolve) => {
          podDeferreds.push(resolve);
        }),
    );

    const { result } = renderHook(() =>
      usePolledMetrics({ clusterId: 'prod', namespace: 'default', updateSpeed: 'normal' }),
    );
    await advance(0);
    expect(getNodeMetrics).toHaveBeenCalledTimes(1);
    expect(getPodMetrics).toHaveBeenCalledTimes(1);

    const interval = UPDATE_SPEED_INTERVAL_MS.normal;
    await advance(interval * 4);
    expect(getNodeMetrics).toHaveBeenCalledTimes(1);
    expect(getPodMetrics).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();

    await act(async () => {
      nodeDeferreds[0]({ available: true, nodes: [nodeA] });
      podDeferreds[0]({ available: true, pods: [podA] });
    });
    expect(result.current.nodes).toEqual([nodeA]);
    expect(result.current.pods).toEqual([podA]);
    expect(result.current.available).toBe(true);
    expect(result.current.error).toBeNull();

    await advance(interval);
    expect(getNodeMetrics).toHaveBeenCalledTimes(2);
    expect(getPodMetrics).toHaveBeenCalledTimes(2);
  });

  const cadenceCases: ReadonlyArray<[UpdateSpeed, number]> = [
    ['low', 5000],
    ['high', 1000],
  ];

  it.each(cadenceCases)('polls at %s speed every %s ms', async (speed, intervalMs) => {
    getNodeMetrics.mockResolvedValue({ available: true, nodes: [] });
    getPodMetrics.mockResolvedValue({ available: true, pods: [] });

    renderHook(() => usePolledMetrics({ clusterId: 'prod', updateSpeed: speed }));
    await advance(0);
    expect(getNodeMetrics).toHaveBeenCalledTimes(1);

    await advance(intervalMs - 1);
    expect(getNodeMetrics).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(getNodeMetrics).toHaveBeenCalledTimes(2);
  });

  it('pauses polling while the document is hidden and resumes when visible', async () => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    getNodeMetrics.mockResolvedValue({ available: true, nodes: [] });
    getPodMetrics.mockResolvedValue({ available: true, pods: [] });

    renderHook(() => usePolledMetrics({ clusterId: 'prod', updateSpeed: 'normal' }));
    await advance(0);
    expect(getNodeMetrics).toHaveBeenCalledTimes(1);

    hidden = true;
    await advance(2000);
    expect(getNodeMetrics).toHaveBeenCalledTimes(1);
    expect(getPodMetrics).toHaveBeenCalledTimes(1);

    hidden = false;
    await advance(2000);
    expect(getNodeMetrics).toHaveBeenCalledTimes(2);
  });

  const availableCases: ReadonlyArray<[boolean, boolean, boolean]> = [
    [true, false, true],
    [false, true, true],
    [false, false, false],
  ];

  it.each(availableCases)(
    'ORs node/pod availability (%s, %s -> %s)',
    async (nodeAvailable, podAvailable, expected) => {
      getNodeMetrics.mockResolvedValue({ available: nodeAvailable, nodes: [nodeA] });
      getPodMetrics.mockResolvedValue({ available: podAvailable, pods: [podA] });

      const { result } = renderHook(() =>
        usePolledMetrics({ clusterId: 'prod', updateSpeed: 'normal' }),
      );
      await advance(0);

      expect(result.current.available).toBe(expected);
      expect(result.current.nodes).toEqual([nodeA]);
      expect(result.current.pods).toEqual([podA]);
      expect(result.current.error).toBeNull();
      expect(typeof result.current.lastUpdated).toBe('number');
    },
  );

  const rejectionCases: ReadonlyArray<[unknown, string]> = [
    [new Error('metrics exploded'), 'metrics exploded'],
    ['raw failure', 'raw failure'],
  ];

  it.each(rejectionCases)('stores the rejection reason as error', async (reason, expected) => {
    getNodeMetrics.mockRejectedValue(reason);
    getPodMetrics.mockResolvedValue({ available: false, pods: [] });

    const { result } = renderHook(() =>
      usePolledMetrics({ clusterId: 'prod', updateSpeed: 'normal' }),
    );
    await advance(0);

    expect(result.current.error).toBe(expected);
    expect(result.current.nodes).toEqual([]);
    expect(result.current.pods).toEqual([]);
    expect(result.current.available).toBe(false);
    expect(result.current.lastUpdated).toBeNull();
  });

  const emptyClusterIds: ReadonlyArray<[string | undefined]> = [[undefined], ['']];

  it.each(emptyClusterIds)(
    'short-circuits without fetching when clusterId is %s',
    async (clusterId) => {
      const { result } = renderHook(() => usePolledMetrics({ clusterId, updateSpeed: 'normal' }));
      await advance(0);

      expect(getNodeMetrics).not.toHaveBeenCalled();
      expect(getPodMetrics).not.toHaveBeenCalled();
      expect(result.current.available).toBe(false);
      expect(result.current.nodes).toEqual([]);
      expect(result.current.pods).toEqual([]);
    },
  );
});

describe('useSeriesBuffer', () => {
  it('appends only when the sample value changes', () => {
    const { result, rerender } = renderHook(
      ({ value, capacity }: { value: number | null; capacity: number }) =>
        useSeriesBuffer(value, capacity),
      { initialProps: { value: 1, capacity: 60 } },
    );

    expect(result.current.map((sample) => sample.v)).toEqual([1]);

    rerender({ value: 1, capacity: 61 });
    expect(result.current.map((sample) => sample.v)).toEqual([1]);

    rerender({ value: 2, capacity: 61 });
    expect(result.current.map((sample) => sample.v)).toEqual([1, 2]);
  });

  it('appends nothing for a null sample', () => {
    const initialProps: { value: number | null } = { value: null };
    const { result, rerender } = renderHook(
      ({ value }: { value: number | null }) => useSeriesBuffer(value),
      { initialProps },
    );
    expect(result.current).toEqual([]);

    rerender({ value: 4 });
    expect(result.current.map((sample) => sample.v)).toEqual([4]);

    rerender({ value: null });
    expect(result.current.map((sample) => sample.v)).toEqual([4]);
  });

  it('caps the buffer at the provided capacity', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: number }) => useSeriesBuffer(value, 3),
      { initialProps: { value: 0 } },
    );

    for (let value = 1; value <= 5; value += 1) rerender({ value });
    expect(result.current.map((sample) => sample.v)).toEqual([3, 4, 5]);
  });

  it('defaults to a capacity of 60', () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: number }) => useSeriesBuffer(value),
      { initialProps: { value: 0 } },
    );

    for (let value = 1; value <= 64; value += 1) rerender({ value });
    expect(result.current).toHaveLength(60);
    expect(result.current.at(-1)?.v).toBe(64);
  });
});

describe('useLocalPref', () => {
  it('returns the initial value when nothing is stored', () => {
    const { result } = renderHook(() => useLocalPref('kos.tm.group', 'deployment'));

    expect(result.current[0]).toBe('deployment');
    expect(window.localStorage.getItem('kos.tm.group')).toBeNull();
  });

  it('reads a previously stored JSON value', () => {
    window.localStorage.setItem('kos.tm.group', JSON.stringify('pod'));

    const { result } = renderHook(() => useLocalPref('kos.tm.group', 'deployment'));
    expect(result.current[0]).toBe('pod');
  });

  it('persists JSON to localStorage when set', () => {
    const { result } = renderHook(() => useLocalPref('kos.tm.speed', 'normal'));

    act(() => {
      result.current[1]('high');
    });

    expect(result.current[0]).toBe('high');
    expect(window.localStorage.getItem('kos.tm.speed')).toBe(JSON.stringify('high'));
  });

  it('falls back to the initial value for invalid JSON', () => {
    window.localStorage.setItem('kos.tm.bad', '{not json');

    const { result } = renderHook(() => useLocalPref('kos.tm.bad', 42));
    expect(result.current[0]).toBe(42);
  });
});
