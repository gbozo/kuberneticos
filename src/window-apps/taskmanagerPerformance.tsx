// Performance page (V2, Phase 3) — Phase 0 placeholder.
import type { ReactElement } from 'react';
import type { TaskManagerViewProps } from './taskmanagerTypes';

export function PerformanceView(props: TaskManagerViewProps): ReactElement {
  return (
    <div
      className="kos-tm-view kos-tm-view--performance"
      data-page="performance"
      data-speed={props.updateSpeed}
    >
      Performance
    </div>
  );
}
