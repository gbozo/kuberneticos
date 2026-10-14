// Services page (V3, Phase 3) — Phase 0 placeholder.
import type { ReactElement } from 'react';
import type { TaskManagerViewProps } from './taskmanagerTypes';

export function ServicesView(props: TaskManagerViewProps): ReactElement {
  return (
    <div
      className="kos-tm-view kos-tm-view--services"
      data-page="services"
      data-speed={props.updateSpeed}
    >
      Services
    </div>
  );
}
