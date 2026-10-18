import type { ReactNode } from 'react';
import { Rnd } from 'react-rnd';
import type { WindowState } from '../state/types';
import { useDesktop } from '../state/DesktopContext';
import { getWindowApp } from '../window-apps/registry';
import { Icon } from './ui';
import './window.css';

const TASKBAR_HEIGHT = 48;

export interface WindowProps {
  window: WindowState;
  children?: ReactNode;
}

export function Window({ window: windowState, children }: WindowProps) {
  const { dispatch } = useDesktop();

  const app = getWindowApp(windowState.appId);
  const keepAlive = app?.keepAlive ?? false;
  const hidden = windowState.minimized && keepAlive;
  if (windowState.minimized && !keepAlive) return null;

  const iconName = app?.icon ?? 'folder';

  const maximized = windowState.maximized;
  const width = maximized ? Math.max(0, window.innerWidth) : windowState.width;
  const height = maximized ? Math.max(0, window.innerHeight - TASKBAR_HEIGHT) : windowState.height;
  const x = maximized ? 0 : windowState.x;
  const y = maximized ? 0 : windowState.y;

  const focusWindow = () => dispatch({ type: 'FOCUS_WINDOW', id: windowState.id });

  return (
    <Rnd
      className={windowState.focused ? 'kos-window is-focused' : 'kos-window is-blurred'}
      style={{
        zIndex: windowState.zIndex,
        // Minimized keepAlive windows stay mounted but out of layout.
        ...(hidden ? { display: 'none' } : {}),
      }}
      size={{ width, height }}
      position={{ x, y }}
      minWidth={250}
      minHeight={30}
      bounds="window"
      dragHandleClassName="kos-window__drag-handle"
      disableDragging={maximized}
      enableResizing={!maximized}
      onDragStart={focusWindow}
      onResizeStart={focusWindow}
      onDragStop={(_event, data) =>
        dispatch({ type: 'MOVE_WINDOW', id: windowState.id, x: data.x, y: data.y })
      }
      onResizeStop={(_event, _direction, ref, _delta, position) => {
        dispatch({
          type: 'RESIZE_WINDOW',
          id: windowState.id,
          width: ref.offsetWidth,
          height: ref.offsetHeight,
        });
        dispatch({ type: 'MOVE_WINDOW', id: windowState.id, x: position.x, y: position.y });
      }}
    >
      <div className="kos-window__frame" onMouseDown={focusWindow}>
        <div className="kos-window__titlebar kos-window__drag-handle">
          <span className="kos-window__icon">
            <Icon name={iconName} size={16} />
          </span>
          <span className="kos-window__title">{windowState.title}</span>
          <div className="kos-window__controls">
            <button
              type="button"
              className="kos-window__control"
              aria-label="Minimize"
              title="Minimize"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                dispatch({ type: 'MINIMIZE_WINDOW', id: windowState.id });
              }}
            >
              <Icon name="minimize" size={16} />
            </button>
            <button
              type="button"
              className="kos-window__control"
              aria-label={maximized ? 'Restore' : 'Maximize'}
              title={maximized ? 'Restore' : 'Maximize'}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                dispatch({ type: 'TOGGLE_MAXIMIZE', id: windowState.id });
              }}
            >
              <Icon name={maximized ? 'restore' : 'maximize'} size={16} />
            </button>
            <button
              type="button"
              className="kos-window__control"
              aria-label="Close"
              title="Close"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                dispatch({ type: 'REMOVE_WINDOW', id: windowState.id });
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>
        <div className="kos-window__body">{children}</div>
      </div>
    </Rnd>
  );
}
