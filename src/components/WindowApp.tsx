import type { WindowState } from '../state/types';
import { getWindowApp } from '../window-apps/registry';
import { Window } from './Window';

export function WindowApp({ window: windowState }: { window: WindowState }) {
  const app = getWindowApp(windowState.appId);

  // keepAlive apps (live exec/X sessions) must not unmount when minimized —
  // Window renders them hidden instead.
  if (windowState.minimized && !(app?.keepAlive ?? false)) return null;

  if (!app) {
    return (
      <Window window={windowState}>
        <div>Unknown application: {windowState.appId}</div>
      </Window>
    );
  }

  const AppComponent = app.component;

  return (
    <Window window={windowState}>
      <AppComponent windowId={windowState.id} props={windowState.props} />
    </Window>
  );
}
