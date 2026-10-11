import type { DesktopAction, DesktopState, WindowState } from './types';

export const DEFAULT_WINDOW_WIDTH = 480;
export const DEFAULT_WINDOW_HEIGHT = 360;
const CASCADE_OFFSET = 24;

function focusById(state: DesktopState, id: string): DesktopState {
  if (!state.windows.some((window) => window.id === id)) return state;
  const zIndex = state.nextZIndex;
  return {
    ...state,
    windows: state.windows.map((window) => {
      if (window.id === id) {
        return { ...window, focused: true, minimized: false, zIndex };
      }
      return window.focused ? { ...window, focused: false } : window;
    }),
    focusedWindowId: id,
    nextZIndex: state.nextZIndex + 1,
  };
}

export function desktopReducer(state: DesktopState, action: DesktopAction): DesktopState {
  switch (action.type) {
    case 'ADD_WINDOW': {
      const { input } = action;
      const cascade = CASCADE_OFFSET + state.windows.length * CASCADE_OFFSET;
      const id = crypto.randomUUID();
      const window: WindowState = {
        id,
        appId: input.appId,
        title: input.title,
        x: input.x ?? cascade,
        y: input.y ?? cascade,
        width: input.width ?? DEFAULT_WINDOW_WIDTH,
        height: input.height ?? DEFAULT_WINDOW_HEIGHT,
        zIndex: state.nextZIndex,
        focused: true,
        minimized: false,
        maximized: false,
        props: input.props ?? {},
      };
      return {
        ...state,
        windows: [
          ...state.windows.map((existing) =>
            existing.focused ? { ...existing, focused: false } : existing,
          ),
          window,
        ],
        focusedWindowId: id,
        startMenuOpen: false,
        nextZIndex: state.nextZIndex + 1,
      };
    }
    case 'REMOVE_WINDOW': {
      if (!state.windows.some((window) => window.id === action.id)) return state;
      return {
        ...state,
        windows: state.windows.filter((window) => window.id !== action.id),
        focusedWindowId: state.focusedWindowId === action.id ? null : state.focusedWindowId,
      };
    }
    case 'FOCUS_WINDOW':
      return focusById(state, action.id);
    case 'RESTORE_WINDOW':
      return focusById(state, action.id);
    case 'TOGGLE_MAXIMIZE': {
      if (!state.windows.some((window) => window.id === action.id)) return state;
      const focused = focusById(state, action.id);
      return {
        ...focused,
        windows: focused.windows.map((window) =>
          window.id === action.id ? { ...window, maximized: !window.maximized } : window,
        ),
      };
    }
    case 'MINIMIZE_WINDOW': {
      if (!state.windows.some((window) => window.id === action.id)) return state;
      const wasFocused = state.focusedWindowId === action.id;
      return {
        ...state,
        windows: state.windows.map((window) =>
          window.id === action.id
            ? { ...window, minimized: true, focused: wasFocused ? false : window.focused }
            : window,
        ),
        focusedWindowId: wasFocused ? null : state.focusedWindowId,
      };
    }
    case 'MOVE_WINDOW': {
      if (!state.windows.some((window) => window.id === action.id)) return state;
      return {
        ...state,
        windows: state.windows.map((window) =>
          window.id === action.id ? { ...window, x: action.x, y: action.y } : window,
        ),
      };
    }
    case 'RESIZE_WINDOW': {
      if (!state.windows.some((window) => window.id === action.id)) return state;
      return {
        ...state,
        windows: state.windows.map((window) =>
          window.id === action.id
            ? { ...window, width: action.width, height: action.height }
            : window,
        ),
      };
    }
    case 'TOGGLE_START_MENU':
      return {
        ...state,
        startMenuOpen: action.open ?? !state.startMenuOpen,
      };
    case 'OPEN_CONTEXT_MENU':
      return {
        ...state,
        contextMenu: { x: action.x, y: action.y, items: action.items },
      };
    case 'CLOSE_CONTEXT_MENU':
      return {
        ...state,
        contextMenu: null,
      };
    default:
      return state;
  }
}

export function getVisibleWindows(state: DesktopState): readonly WindowState[] {
  return state.windows.filter((window) => !window.minimized).sort((a, b) => a.zIndex - b.zIndex);
}

export function getTaskbarWindows(state: DesktopState): readonly WindowState[] {
  return [...state.windows].sort((a, b) => a.zIndex - b.zIndex);
}

export function getFocusedWindow(state: DesktopState): WindowState | null {
  return state.windows.find((window) => window.id === state.focusedWindowId) ?? null;
}
