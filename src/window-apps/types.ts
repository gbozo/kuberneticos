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
}
