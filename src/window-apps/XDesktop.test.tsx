import { StrictMode, act } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openXDisplaySession, releaseXDisplaySession } from '../cluster/streams';
import type { RfbHandlers } from '../cluster/streams';
import { connectRfbStream } from '../cluster/streams';
import { XDesktop } from './XDesktop';

vi.mock('../cluster/streams', () => ({
  openXDisplaySession: vi.fn(),
  releaseXDisplaySession: vi.fn(),
  connectRfbStream: vi.fn(),
  streamErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const openSession = vi.mocked(openXDisplaySession);
const releaseSession = vi.mocked(releaseXDisplaySession);
const connectRfb = vi.mocked(connectRfbStream);

const PROPS = {
  windowId: 'w1',
  props: { namespace: 'team-a', pod: 'web-1', command: ['firefox'], title: 'web-1/firefox' },
};

function lastRfbHandlers(): RfbHandlers {
  const handlers = connectRfb.mock.calls.at(-1)?.[2];
  if (handlers === undefined) throw new Error('connectRfbStream was not called');
  return handlers;
}

describe('XDesktop session lifecycle', () => {
  beforeEach(() => {
    releaseSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reaches the connected state and shows the display badge', async () => {
    openSession.mockResolvedValue({
      display: 22,
      token: 't1',
      wsPath: '/api/xdisplay/ws?token=t1',
    });
    connectRfb.mockReturnValue({ disconnect: vi.fn(), rescale: vi.fn() });

    render(<XDesktop {...PROPS} />);

    await waitFor(() => {
      expect(openSession).toHaveBeenCalledWith({
        namespace: 'team-a',
        pod: 'web-1',
        container: undefined,
        app: undefined,
        command: ['firefox'],
      });
    });
    await act(async () => {
      lastRfbHandlers().onStatus?.('connected');
    });
    expect(await screen.findByText(':22')).toBeTruthy();
  });

  it('opens exactly one live session under StrictMode and releases it on unmount', async () => {
    let openCount = 0;
    openSession.mockImplementation(async () => {
      openCount += 1;
      return { display: 21, token: `t${openCount}`, wsPath: `/ws?t${openCount}` };
    });
    connectRfb.mockReturnValue({ disconnect: vi.fn(), rescale: vi.fn() });

    const view = render(
      <StrictMode>
        <XDesktop {...PROPS} />
      </StrictMode>,
    );

    await waitFor(() => expect(openCount).toBeGreaterThanOrEqual(1));

    view.unmount();

    // Every opened session is released exactly once, whatever the mount pattern.
    await waitFor(() => {
      expect(releaseSession.mock.calls.length).toBe(openCount);
    });
    expect(releaseSession).toHaveBeenCalledWith('t1');
  });

  it('releases a session even when it resolves after the window unmounted', async () => {
    let acceptSession: (session: { display: number; token: string; wsPath: string }) => void = () =>
      undefined;
    openSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          acceptSession = resolve;
        }),
    );
    connectRfb.mockReturnValue({ disconnect: vi.fn(), rescale: vi.fn() });

    const view = render(<XDesktop {...PROPS} />);
    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(1));

    view.unmount();
    acceptSession({ display: 25, token: 'late-token', wsPath: '/ws?late' });

    await waitFor(() => {
      expect(releaseSession).toHaveBeenCalledTimes(1);
    });
    expect(releaseSession).toHaveBeenCalledWith('late-token');
  });

  it('releases the session when the window unmounts', async () => {
    const handle = { disconnect: vi.fn(), rescale: vi.fn() };
    openSession.mockResolvedValue({
      display: 21,
      token: 't9',
      wsPath: '/api/xdisplay/ws?token=t9',
    });
    connectRfb.mockReturnValue(handle);

    const view = render(<XDesktop {...PROPS} />);
    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(1));
    await act(async () => {
      lastRfbHandlers().onStatus?.('connected');
    });
    expect(await screen.findByText(':21')).toBeTruthy();

    view.unmount();

    expect(handle.disconnect).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(releaseSession).toHaveBeenCalledWith('t9');
    });
  });

  it('shows the error overlay with a Retry action and reopens on Retry', async () => {
    const failure = new Error('Stream API request failed: 503 Service Unavailable (/api/xdisplay)');
    openSession.mockRejectedValueOnce(failure);
    openSession.mockResolvedValueOnce({ display: 24, token: 't5', wsPath: '/ws?t5' });
    connectRfb.mockReturnValue({ disconnect: vi.fn(), rescale: vi.fn() });

    render(<XDesktop {...PROPS} />);

    expect(await screen.findByText(/503 Service Unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(openSession).toHaveBeenCalledTimes(2));
    await act(async () => {
      lastRfbHandlers().onStatus?.('connected');
    });
    await screen.findByText(':24');
    expect(openSession).toHaveBeenCalledTimes(2);
  });

  it('shows the missing-setup error without a Retry action when props are empty', () => {
    openSession.mockResolvedValue({ display: 21, token: 't', wsPath: '/ws' });

    render(<XDesktop windowId="w2" props={{}} />);

    expect(
      screen.getByText('No pod or app command — open a remote app from Cluster Explorer.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(openSession).not.toHaveBeenCalled();
  });
});
