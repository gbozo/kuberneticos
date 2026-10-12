import { ClusterExplorer } from './ClusterExplorer';
import { TaskManager } from './TaskManager';
import { TestWindow } from './TestWindow';
import type { WindowAppDefinition } from './types';

export const windowApps: readonly WindowAppDefinition[] = [
  {
    id: 'TestWindow',
    title: 'Test Window',
    icon: 'terminal',
    component: TestWindow,
  },
  {
    id: 'ClusterExplorer',
    title: 'Cluster Explorer',
    icon: 'server',
    component: ClusterExplorer,
  },
  {
    id: 'TaskManager',
    title: 'Task Manager',
    icon: 'activity',
    component: TaskManager,
  },
];

export function getWindowApp(id: string): WindowAppDefinition | undefined {
  return windowApps.find((app) => app.id === id);
}

export function listWindowApps(): readonly WindowAppDefinition[] {
  return windowApps;
}
