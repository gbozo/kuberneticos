import { useDesktop } from '../state/DesktopContext';
import { getTaskbarWindows } from '../state/reducer';
import { getWindowApp } from '../window-apps/registry';
import { AppBarButton } from './ui';

export function TaskBarWindows() {
  const { state, dispatch } = useDesktop();
  const windows = getTaskbarWindows(state);

  const handleActivate = (id: string): void => {
    const window = state.windows.find((candidate) => candidate.id === id);
    if (!window) return;
    if (state.focusedWindowId === id && !window.minimized) {
      dispatch({ type: 'MINIMIZE_WINDOW', id });
    } else {
      dispatch({ type: 'FOCUS_WINDOW', id });
    }
  };

  return (
    <>
      {windows.map((window) => (
        <AppBarButton
          key={window.id}
          icon={getWindowApp(window.appId)?.icon ?? 'folder'}
          label={window.title}
          title={window.title}
          active={window.id === state.focusedWindowId}
          onClick={() => handleActivate(window.id)}
        />
      ))}
    </>
  );
}
