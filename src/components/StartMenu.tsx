import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useDesktop } from '../state/DesktopContext';
import { getCurrentTheme, subscribeTheme } from '../theme/theme';
import { listWindowApps } from '../window-apps/registry';
import { Icon, ListView } from './ui';
import './startmenu.css';

export interface StartMenuProps {
  onCycleTheme?: () => void;
}

export function StartMenu({ onCycleTheme }: StartMenuProps) {
  const { state, dispatch } = useDesktop();
  const theme = useSyncExternalStore(subscribeTheme, getCurrentTheme);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = state.startMenuOpen;

  useEffect(() => {
    if (!open) return;

    const handleClick = (event: MouseEvent): void => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        dispatch({ type: 'TOGGLE_START_MENU', open: false });
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        dispatch({ type: 'TOGGLE_START_MENU', open: false });
      }
    };

    // Defer the outside-click listener by a macrotask. React flushes this effect
    // synchronously at the end of the discrete click that opened the menu, so the
    // opening click is still bubbling to `document` and would otherwise dismiss
    // the menu in the same tick it appeared.
    const timer = window.setTimeout(() => {
      document.addEventListener('click', handleClick);
    }, 0);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, dispatch]);

  if (!open) return null;

  return (
    <div className="kos-startmenu" ref={panelRef}>
      <header className="kos-startmenu__header">Kubernetic OS</header>
      <div className="kos-startmenu__apps">
        <ListView>
          {listWindowApps().map((app) => (
            <li key={app.id} className="kos-startmenu__item">
              <button
                type="button"
                className="kos-startmenu__launch"
                onClick={() =>
                  dispatch({
                    type: 'ADD_WINDOW',
                    input: { appId: app.id, title: app.title, props: {} },
                  })
                }
              >
                <Icon name={app.icon} size={20} />
                <span>{app.title}</span>
              </button>
            </li>
          ))}
        </ListView>
      </div>
      <footer className="kos-startmenu__footer">
        <span className="kos-startmenu__note">Cluster API: /api</span>
        {onCycleTheme ? (
          <button type="button" className="kos-startmenu__theme" onClick={onCycleTheme}>
            <Icon name="settings" size={14} />
            <span>{theme}</span>
          </button>
        ) : null}
      </footer>
    </div>
  );
}
