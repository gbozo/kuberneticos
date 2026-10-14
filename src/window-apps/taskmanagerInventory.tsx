// Inventory pages (V4, Phase 3): Pods / Namespaces / Nodes / Settings — Phase 0 placeholder.
import type { ReactElement } from 'react';
import type { TaskManagerInventoryProps } from './taskmanagerTypes';

export function InventoryView(props: TaskManagerInventoryProps): ReactElement {
  return (
    <div
      className="kos-tm-view kos-tm-view--inventory"
      data-page={props.page}
      data-speed={props.updateSpeed}
    >
      {props.page}
    </div>
  );
}
