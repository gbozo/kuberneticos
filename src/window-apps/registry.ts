import { ClusterExplorer } from './ClusterExplorer';
import { TaskManager } from './TaskManager';
import { Terminal } from './Terminal';
import { TestWindow } from './TestWindow';
import { XDesktop } from './XDesktop';
import type { WindowAppDefinition } from './types';

const devWindowApps: readonly WindowAppDefinition[] = (
  import.meta as ImportMeta & { env: { DEV: boolean } }
).env.DEV
  ? [
      {
        id: 'TestWindow',
        title: 'Test Window',
        icon: 'terminal',
        component: TestWindow,
      },
    ]
  : [];

export const windowApps: readonly WindowAppDefinition[] = [
  ...devWindowApps,
  {
    id: 'ClusterExplorer',
    title: 'Cluster Explorer',
    icon: 'server',
    component: ClusterExplorer,
  },
  {
    id: 'Terminal',
    title: 'Terminal',
    icon: 'terminal',
    keepAlive: true,
    component: Terminal,
  },
  {
    id: 'XDesktop',
    title: 'Remote App',
    icon: 'box',
    keepAlive: true,
    component: XDesktop,
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
