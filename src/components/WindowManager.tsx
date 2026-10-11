import { useDesktop } from '../state/DesktopContext';
import { getVisibleWindows } from '../state/reducer';
import { WindowApp } from './WindowApp';

export function WindowManager() {
  const { state } = useDesktop();
  const windows = getVisibleWindows(state);

  return (
    <>
      {windows.map((window) => (
        <WindowApp key={window.id} window={window} />
      ))}
    </>
  );
}
