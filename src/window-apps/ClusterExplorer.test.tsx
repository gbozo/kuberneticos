import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopProvider, useDesktop } from '../state/DesktopContext';
import type { DesktopState } from '../state/types';
import { ClusterExplorer } from './ClusterExplorer';

type FetchMock = ReturnType<
  typeof vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>
>;

function stubFetch(routes: Record<string, unknown>): FetchMock {
  const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>();
  fetchMock.mockImplementation((input) => {
    const url = new URL(String(input), 'http://localhost');
    const payload: unknown = routes[url.pathname] ?? { source: 'go' };
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const clusters = [{ id: 'c1', name: 'Cluster 1', server: 'https://c1.example' }];

const pods = [
  {
    name: 'web-1',
    namespace: 'team-a',
    node: 'n1',
    phase: 'Running',
    annotations: { 'kos.dev/x-app': 'firefox --private-window' },
  },
  { name: 'db-1', namespace: 'team-a', phase: 'Running' },
];

function stubPods(): FetchMock {
  return stubFetch({
    '/api/clusters': { source: 'go', clusters },
    '/api/pods': { source: 'go', pods },
  });
}

interface Capture {
  current: DesktopState | null;
}

function Harness({ stateRef, children }: { stateRef: Capture; children: ReactElement }) {
  const { state } = useDesktop();
  stateRef.current = state;
  return children;
}

async function renderExplorer(): Promise<Capture> {
  const stateRef: Capture = { current: null };
  render(
    <DesktopProvider>
      <Harness stateRef={stateRef}>
        <ClusterExplorer />
      </Harness>
    </DesktopProvider>,
  );
  await screen.findByText('web-1');
  return stateRef;
}

describe('ClusterExplorer pod actions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens a Terminal window with the pod coordinates', async () => {
    stubPods();
    const stateRef = await renderExplorer();

    const terminalButtons = screen.getAllByRole('button', { name: /open terminal/i });
    fireEvent.click(terminalButtons[0]);

    const state = stateRef.current as DesktopState;
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0]).toMatchObject({ appId: 'Terminal', title: 'Terminal — web-1' });
    expect(state.windows[0].props).toEqual({ namespace: 'team-a', pod: 'web-1' });
  });

  it('opens an XDesktop window with the annotation command for flagged pods', async () => {
    stubPods();
    const stateRef = await renderExplorer();

    const guiButtons = screen.getAllByRole('button', { name: /open gui app/i });
    expect((guiButtons[0] as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(guiButtons[0]);

    const state = stateRef.current as DesktopState;
    expect(state.windows).toHaveLength(1);
    expect(state.windows[0]).toMatchObject({
      appId: 'XDesktop',
      title: 'web-1/firefox',
    });
    expect(state.windows[0].props).toEqual({
      namespace: 'team-a',
      pod: 'web-1',
      command: ['firefox', '--private-window'],
      title: 'web-1/firefox',
    });
  });

  it('disables Open GUI app for pods without the annotation', async () => {
    stubPods();
    const stateRef = await renderExplorer();

    const guiButtons = screen.getAllByRole('button', { name: /open gui app/i });
    expect((guiButtons[1] as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(guiButtons[1]);
    expect((stateRef.current as DesktopState).windows).toHaveLength(0);
  });

  it('shows the empty state without pods', async () => {
    stubFetch({
      '/api/clusters': { source: 'go', clusters },
      '/api/pods': { source: 'go', pods: [] },
    });

    render(
      <DesktopProvider>
        <ClusterExplorer />
      </DesktopProvider>,
    );
    await screen.findByText('No pods');
  });
});
