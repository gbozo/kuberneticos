import type { ComponentType } from 'react';
import type { KosIconName } from '../components/ui';

export interface WindowAppProps {
  windowId: string;
  props: Record<string, unknown>;
}

export interface WindowAppDefinition {
  id: string;
  title: string;
  icon: KosIconName;
  component: ComponentType<WindowAppProps>;
  /**
   * Apps holding live remote connections (exec websockets, X display sessions)
   * set this so a minimized window stays mounted (hidden with display:none)
   * instead of unmounting its React tree and tearing the session down.
   */
  keepAlive?: boolean;
}
