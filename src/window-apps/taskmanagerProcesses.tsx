// Workloads page (V1, Phase 3) — Phase 0 placeholder.
import type { ReactElement } from 'react';
import type { TaskManagerViewProps } from './taskmanagerTypes';

export function ProcessesView(props: TaskManagerViewProps): ReactElement {
  return (
    <div
      className="kos-tm-view kos-tm-view--workloads"
      data-page="workloads"
      data-speed={props.updateSpeed}
    >
      Workloads
    </div>
  );
}
