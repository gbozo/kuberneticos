import { useDesktop } from '../state/DesktopContext';
import { WindowApp } from './WindowApp';

export function WindowManager() {
  const { state } = useDesktop();
  // Every window is in the list (not just visible ones) so `keepAlive` apps
  // keep their live sessions mounted while minimized; WindowApp/Window hide
  // those instead of unmounting them.
  const windows = [...state.windows].sort((a, b) => a.zIndex - b.zIndex);

  return (
    <>
      {windows.map((window) => (
        <WindowApp key={window.id} window={window} />
      ))}
    </>
  );
}
