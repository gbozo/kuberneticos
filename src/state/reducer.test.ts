import { describe, it, expect } from 'vitest';
import { initialDesktopState } from './types';
import type { DesktopState } from './types';
import { desktopReducer, getFocusedWindow, getTaskbarWindows, getVisibleWindows } from './reducer';
import { createDesktopEventBus } from './events';

function addWindow(state: DesktopState): DesktopState {
  return desktopReducer(state, {
    type: 'ADD_WINDOW',
    input: { appId: 'TestWindow', title: 'Test' },
  });
}

describe('desktopReducer', () => {
  it('adds a window, focuses it, and closes the start menu', () => {
    const opened = desktopReducer(initialDesktopState, { type: 'TOGGLE_START_MENU' });
    expect(opened.startMenuOpen).toBe(true);

    const state = addWindow(opened);
    expect(state.windows).toHaveLength(1);

    const [window] = state.windows;
    expect(typeof window.id).toBe('string');
    expect(window.id.length).toBeGreaterThan(0);
    expect(window.focused).toBe(true);
    expect(state.focusedWindowId).toBe(window.id);
    expect(state.startMenuOpen).toBe(false);
    expect(window.zIndex).toBe(1);
    expect(state.nextZIndex).toBe(2);
    expect(window.width).toBe(480);
    expect(window.height).toBe(360);
    expect(window.minimized).toBe(false);
    expect(window.maximized).toBe(false);
    expect(getFocusedWindow(state)).toBe(window);
  });

  it('cascades each new window and re-focuses the newest', () => {
    const first = addWindow(initialDesktopState);
    const second = addWindow(first);

    expect(second.windows).toHaveLength(2);
    const [w1, w2] = second.windows;
    expect(second.focusedWindowId).toBe(w2.id);
    expect(w2.focused).toBe(true);
    expect(w1.focused).toBe(false);
    expect(w2.x - w1.x).toBe(24);
    expect(w2.y - w1.y).toBe(24);
    expect(w2.zIndex).toBeGreaterThan(w1.zIndex);
  });

  it('removes a window and clears focus when the removed window was focused', () => {
    const state = addWindow(initialDesktopState);
    const id = state.windows[0].id;

    const removed = desktopReducer(state, { type: 'REMOVE_WINDOW', id });
    expect(removed.windows).toHaveLength(0);
    expect(removed.focusedWindowId).toBeNull();
    expect(getFocusedWindow(removed)).toBeNull();
  });

  it('focuses a window by raising zIndex and de-focusing others', () => {
    let state = addWindow(initialDesktopState);
    state = addWindow(state);
    const firstId = state.windows[0].id;
    const secondId = state.windows[1].id;

    const focused = desktopReducer(state, { type: 'FOCUS_WINDOW', id: firstId });
    const first = focused.windows.find((w) => w.id === firstId);
    const second = focused.windows.find((w) => w.id === secondId);

    expect(first?.focused).toBe(true);
    expect(second?.focused).toBe(false);
    expect(first?.zIndex).toBeGreaterThan(second?.zIndex ?? Number.POSITIVE_INFINITY);
    expect(focused.focusedWindowId).toBe(firstId);
  });

  it('minimizes the focused window clearing focus, then restores it to the top', () => {
    let state = addWindow(initialDesktopState);
    state = addWindow(state);
    const secondId = state.windows[1].id;

    const minimized = desktopReducer(state, { type: 'MINIMIZE_WINDOW', id: secondId });
    const minWindow = minimized.windows.find((w) => w.id === secondId);
    expect(minWindow?.minimized).toBe(true);
    expect(minWindow?.focused).toBe(false);
    expect(minimized.focusedWindowId).toBeNull();

    const restored = desktopReducer(minimized, { type: 'RESTORE_WINDOW', id: secondId });
    const restWindow = restored.windows.find((w) => w.id === secondId);
    expect(restWindow?.minimized).toBe(false);
    expect(restWindow?.focused).toBe(true);
    expect(restored.focusedWindowId).toBe(secondId);
    expect(restWindow?.zIndex).toBe(Math.max(...restored.windows.map((w) => w.zIndex)));
  });

  it('patches geometry immutably', () => {
    const state = addWindow(initialDesktopState);
    const id = state.windows[0].id;
    const originalWindow = state.windows[0];

    const moved = desktopReducer(state, { type: 'MOVE_WINDOW', id, x: 111, y: 222 });
    expect(moved).not.toBe(state);
    expect(moved.windows[0].x).toBe(111);
    expect(moved.windows[0].y).toBe(222);
    expect(state.windows[0]).toBe(originalWindow);
    expect(state.windows[0].x).toBe(originalWindow.x);

    const resized = desktopReducer(state, {
      type: 'RESIZE_WINDOW',
      id,
      width: 700,
      height: 500,
    });
    expect(resized.windows[0].width).toBe(700);
    expect(resized.windows[0].height).toBe(500);
    expect(state.windows[0]).toBe(originalWindow);
    expect(state.windows[0].width).toBe(480);
  });

  it('toggles the start menu with explicit and inverted forms', () => {
    const opened = desktopReducer(initialDesktopState, {
      type: 'TOGGLE_START_MENU',
      open: true,
    });
    expect(opened.startMenuOpen).toBe(true);

    const explicitlyClosed = desktopReducer(opened, {
      type: 'TOGGLE_START_MENU',
      open: false,
    });
    expect(explicitlyClosed.startMenuOpen).toBe(false);

    const inverted = desktopReducer(opened, { type: 'TOGGLE_START_MENU' });
    expect(inverted.startMenuOpen).toBe(false);
    const invertedBack = desktopReducer(inverted, { type: 'TOGGLE_START_MENU' });
    expect(invertedBack.startMenuOpen).toBe(true);
  });

  it('sets and clears the context menu', () => {
    const items = [{ id: 'close', label: 'Close' }] as const;
    const opened = desktopReducer(initialDesktopState, {
      type: 'OPEN_CONTEXT_MENU',
      x: 10,
      y: 20,
      items,
    });
    expect(opened.contextMenu).toEqual({ x: 10, y: 20, items });

    const closed = desktopReducer(opened, { type: 'CLOSE_CONTEXT_MENU' });
    expect(closed.contextMenu).toBeNull();
  });

  it('toggles maximize, focusing the window and preserving stored geometry', () => {
    let state = addWindow(initialDesktopState);
    state = addWindow(state);
    const firstId = state.windows[0].id;
    const geometry = { x: state.windows[0].x, y: state.windows[0].y };

    const maximized = desktopReducer(state, { type: 'TOGGLE_MAXIMIZE', id: firstId });
    const maxWindow = maximized.windows.find((w) => w.id === firstId);
    expect(maxWindow?.maximized).toBe(true);
    expect(maxWindow?.focused).toBe(true);
    expect(maximized.focusedWindowId).toBe(firstId);
    // stored geometry is untouched so un-maximize restores it
    expect(maxWindow?.x).toBe(geometry.x);
    expect(maxWindow?.y).toBe(geometry.y);

    const restored = desktopReducer(maximized, { type: 'TOGGLE_MAXIMIZE', id: firstId });
    expect(restored.windows.find((w) => w.id === firstId)?.maximized).toBe(false);
  });

  it('sorts visible windows ascending excluding minimized, taskbar includes all', () => {
    let state = addWindow(initialDesktopState);
    state = addWindow(state);
    state = addWindow(state);
    const [w1, w2, w3] = state.windows;

    state = desktopReducer(state, { type: 'MINIMIZE_WINDOW', id: w2.id });
    state = desktopReducer(state, { type: 'FOCUS_WINDOW', id: w1.id });

    const visible = getVisibleWindows(state);
    expect(visible.map((w) => w.id)).toEqual([w3.id, w1.id]);

    const taskbar = getTaskbarWindows(state);
    expect(taskbar.map((w) => w.id)).toEqual([w2.id, w3.id, w1.id]);
    const zIndexes = taskbar.map((w) => w.zIndex);
    expect(zIndexes).toEqual([...zIndexes].sort((a, b) => a - b));
  });

  it('does not mutate the input state on any action', () => {
    const state = addWindow(initialDesktopState);
    const snapshot = structuredClone(state);

    desktopReducer(state, { type: 'FOCUS_WINDOW', id: state.windows[0].id });
    desktopReducer(state, { type: 'MINIMIZE_WINDOW', id: state.windows[0].id });
    desktopReducer(state, { type: 'TOGGLE_START_MENU' });

    expect(state).toEqual(snapshot);
  });
});

describe('createDesktopEventBus', () => {
  it('delivers events to subscribers and stops after unsubscribe', () => {
    const bus = createDesktopEventBus();
    const received: string[] = [];
    const unsubscribe = bus.subscribe((event) => {
      received.push(event.type);
    });

    bus.emit({ type: 'window-added', id: 'a' });
    expect(received).toEqual(['window-added']);

    unsubscribe();
    bus.emit({ type: 'window-removed', id: 'a' });
    expect(received).toEqual(['window-added']);
  });

  it('does not let a throwing subscriber block others', () => {
    const bus = createDesktopEventBus();
    const received: string[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((event) => {
      received.push(event.type);
    });

    expect(() => bus.emit({ type: 'window-focused', id: 'a' })).not.toThrow();
    expect(received).toEqual(['window-focused']);
  });
});
