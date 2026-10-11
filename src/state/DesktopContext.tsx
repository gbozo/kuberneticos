import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from 'react';
import { desktopReducer } from './reducer';
import { initialDesktopState } from './types';
import type { DesktopAction, DesktopState } from './types';
import { createDesktopEventBus } from './events';
import type { DesktopEvent, DesktopEventBus } from './events';

export interface DesktopContextValue {
  state: DesktopState;
  dispatch: Dispatch<DesktopAction>;
  bus: DesktopEventBus;
}

const DesktopContext = createContext<DesktopContextValue | null>(null);

interface DesktopProviderProps {
  children: ReactNode;
}

export function DesktopProvider({ children }: DesktopProviderProps) {
  const [state, dispatch] = useReducer(desktopReducer, initialDesktopState);
  const [bus] = useState(createDesktopEventBus);
  const previousStateRef = useRef(state);

  useEffect(() => {
    const previous = previousStateRef.current;
    if (previous === state) return;
    previousStateRef.current = state;

    const previousById = new Map(previous.windows.map((window) => [window.id, window]));
    const nextById = new Map(state.windows.map((window) => [window.id, window]));

    for (const id of nextById.keys()) {
      if (!previousById.has(id)) bus.emit({ type: 'window-added', id });
    }
    for (const id of previousById.keys()) {
      if (!nextById.has(id)) bus.emit({ type: 'window-removed', id });
    }

    if (previous.focusedWindowId !== state.focusedWindowId && state.focusedWindowId !== null) {
      bus.emit({ type: 'window-focused', id: state.focusedWindowId });
    }

    for (const window of state.windows) {
      const before = previousById.get(window.id);
      if (!before) continue;
      if (!before.minimized && window.minimized) {
        bus.emit({ type: 'window-minimized', id: window.id });
      } else if (before.minimized && !window.minimized) {
        bus.emit({ type: 'window-restored', id: window.id });
      }
    }

    if (previous.startMenuOpen !== state.startMenuOpen) {
      bus.emit({ type: 'start-menu-toggled', open: state.startMenuOpen });
    }
  }, [state, bus]);

  const value = useMemo<DesktopContextValue>(() => ({ state, dispatch, bus }), [state, bus]);

  return <DesktopContext.Provider value={value}>{children}</DesktopContext.Provider>;
}

export function useDesktop(): DesktopContextValue {
  const value = useContext(DesktopContext);
  if (value === null) {
    throw new Error('useDesktop must be used within a DesktopProvider');
  }
  return value;
}

export function useDesktopEvent<T extends DesktopEvent['type']>(
  type: T,
  handler: (event: Extract<DesktopEvent, { type: T }>) => void,
): void {
  const { bus } = useDesktop();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    return bus.subscribe((event) => {
      if (event.type === type) {
        handlerRef.current(event as Extract<DesktopEvent, { type: T }>);
      }
    });
  }, [bus, type]);
}
