import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClusterClient, OfflineClusterClient, createClusterClient } from './client';
import type { ClusterInfo, NodeInfo, PodInfo } from './client';

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
});

describe('createClusterClient', () => {
  it('returns an HttpClusterClient', () => {
    expect(createClusterClient()).toBeInstanceOf(HttpClusterClient);
  });
});
