import { ClusterExplorer } from './ClusterExplorer';
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
];

export function getWindowApp(id: string): WindowAppDefinition | undefined {
  return windowApps.find((app) => app.id === id);
}

export function listWindowApps(): readonly WindowAppDefinition[] {
  return windowApps;
}
