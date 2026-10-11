import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDesktop } from '../state/DesktopContext';
import type { ContextMenuItem } from '../state/types';
import { Menu, MenuItem, Separator } from './ui';
import './contextmenu.css';

export interface ContextMenuProps {
  onRefresh?: () => void;
  onCycleTheme?: () => void;
}

const DEFAULT_ITEMS: readonly ContextMenuItem[] = [
  { id: 'refresh', label: 'Refresh', action: 'refresh' },
  { id: 'theme', label: 'Change theme', action: 'theme' },
  { id: 'separator', label: 'Separator', action: 'separator', disabled: true },
  { id: 'close-all', label: 'Close all windows', action: 'close-all' },
];

export function ContextMenu({ onRefresh, onCycleTheme }: ContextMenuProps) {
  const { state, dispatch } = useDesktop();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const contextMenu = state.contextMenu;
  const opened = contextMenu !== null;

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      dispatch({
        type: 'OPEN_CONTEXT_MENU',
        x: event.clientX,
        y: event.clientY,
        items: DEFAULT_ITEMS,
      });
    };
    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, [dispatch]);

  useEffect(() => {
    if (!opened) return;

    const handleClick = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      dispatch({ type: 'CLOSE_CONTEXT_MENU' });
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') dispatch({ type: 'CLOSE_CONTEXT_MENU' });
    };
    const handleScroll = (): void => {
      dispatch({ type: 'CLOSE_CONTEXT_MENU' });
    };

    document.addEventListener('click', handleClick);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [opened, dispatch]);

  useLayoutEffect(() => {
    if (!contextMenu) return;
    const element = menuRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const flippedX = Math.max(0, Math.min(contextMenu.x, window.innerWidth - rect.width));
    const flippedY = Math.max(0, Math.min(contextMenu.y, window.innerHeight - rect.height));
    setPosition({ x: flippedX, y: flippedY });
  }, [contextMenu]);

  const handleAction = (action?: string): void => {
    switch (action) {
      case 'theme':
        onCycleTheme?.();
        break;
      case 'close-all':
        for (const window of state.windows) {
          dispatch({ type: 'REMOVE_WINDOW', id: window.id });
        }
        break;
      case 'refresh':
        onRefresh?.();
        break;
      default:
        break;
    }
    dispatch({ type: 'CLOSE_CONTEXT_MENU' });
  };

  if (!contextMenu) return null;

  return (
    <div ref={menuRef} className="kos-contextmenu" style={{ left: position.x, top: position.y }}>
      <Menu>
        {contextMenu.items.map((item) => {
          if (item.id === 'separator') {
            return <Separator key={item.id} />;
          }
          return (
            <MenuItem
              key={item.id}
              label={item.label}
              disabled={item.disabled}
              onClick={item.disabled ? undefined : () => handleAction(item.action)}
            />
          );
        })}
      </Menu>
    </div>
  );
}
