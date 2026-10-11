import { useCallback, useEffect, useState } from 'react';
import { ContextMenu } from './components/Contextmenu';
import { StartMenu } from './components/StartMenu';
import { TaskBar } from './components/TaskBar';
import { WindowManager } from './components/WindowManager';
import { DesktopProvider } from './state/DesktopContext';
import { applyTheme, loadTheme, nextTheme, saveTheme } from './theme/theme';
import type { ThemeName } from './theme/theme';
import './theme/tokens.css';
import './theme/global.css';

const noop = (): void => undefined;

export default function App() {
  const [theme, setTheme] = useState<ThemeName>(loadTheme);

  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

  const cycleTheme = useCallback(() => {
    setTheme((current) => nextTheme(current));
  }, []);

  return (
    <DesktopProvider>
      <div className="kos-desktop">
        <WindowManager />
        <TaskBar onCycleTheme={cycleTheme} />
        <StartMenu onCycleTheme={cycleTheme} />
        <ContextMenu onRefresh={noop} onCycleTheme={cycleTheme} />
      </div>
    </DesktopProvider>
  );
}
