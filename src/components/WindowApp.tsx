import type { WindowState } from '../state/types';
import { getWindowApp } from '../window-apps/registry';
import { Window } from './Window';

export function WindowApp({ window: windowState }: { window: WindowState }) {
  if (windowState.minimized) return null;

  const app = getWindowApp(windowState.appId);

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
