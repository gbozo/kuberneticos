import { useSyncExternalStore } from 'react';
import { useDesktop } from '../state/DesktopContext';
import { getCurrentTheme, subscribeTheme } from '../theme/theme';
import { TaskBarClock } from './TaskBarClock';
import { TaskBarWindows } from './TaskBarWindows';
import { AppBarButton, AppBarSeparator } from './ui';
import './taskbar.css';

export interface TaskBarProps {
  onCycleTheme?: () => void;
}

export function TaskBar({ onCycleTheme }: TaskBarProps) {
  const { state, dispatch } = useDesktop();
  const theme = useSyncExternalStore(subscribeTheme, getCurrentTheme);

  return (
    <div className="kos-taskbar">
      <div className="kos-taskbar__side kos-taskbar__side--left">
        <AppBarButton
          icon="start"
          label="Start"
          active={state.startMenuOpen}
          onClick={() => dispatch({ type: 'TOGGLE_START_MENU', open: !state.startMenuOpen })}
        />
        <AppBarSeparator />
      </div>
      <div className="kos-taskbar__center">
        <TaskBarWindows />
      </div>
      <div className="kos-taskbar__side kos-taskbar__side--right">
        {onCycleTheme ? (
          <AppBarButton
            icon="settings"
            label={theme}
            title={`Theme: ${theme}`}
            onClick={onCycleTheme}
          />
        ) : null}
        <TaskBarClock />
      </div>
    </div>
  );
}
