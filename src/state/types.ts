export interface WindowPosition {
  x: number;
  y: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

export interface WindowState {
  id: string; // crypto.randomUUID()
  appId: string; // which window app to render
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  focused: boolean;
  minimized: boolean;
  maximized: boolean;
  props: Record<string, unknown>; // app-specific payload
}

export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  action?: string; // semantic action name resolved by the consumer
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: readonly ContextMenuItem[];
}

export interface DesktopState {
  windows: readonly WindowState[];
  focusedWindowId: string | null;
  startMenuOpen: boolean;
  contextMenu: ContextMenuState | null;
  nextZIndex: number; // monotonically increasing counter
}

export const initialDesktopState: DesktopState = {
  windows: [],
  focusedWindowId: null,
  startMenuOpen: false,
  contextMenu: null,
  nextZIndex: 1,
};

export interface AddWindowInput {
  appId: string;
  title: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  props?: Record<string, unknown>;
}

export type DesktopAction =
  | { type: 'ADD_WINDOW'; input: AddWindowInput }
  | { type: 'REMOVE_WINDOW'; id: string }
  | { type: 'FOCUS_WINDOW'; id: string }
  | { type: 'MINIMIZE_WINDOW'; id: string }
  | { type: 'RESTORE_WINDOW'; id: string }
  | { type: 'TOGGLE_MAXIMIZE'; id: string }
  | { type: 'MOVE_WINDOW'; id: string; x: number; y: number }
  | { type: 'RESIZE_WINDOW'; id: string; width: number; height: number }
  | { type: 'TOGGLE_START_MENU'; open?: boolean }
  | { type: 'OPEN_CONTEXT_MENU'; x: number; y: number; items: readonly ContextMenuItem[] }
  | { type: 'CLOSE_CONTEXT_MENU' };
