import type { CSSProperties, ReactNode } from 'react';

export interface ListViewProps {
  children: ReactNode;
  style?: CSSProperties;
}

export function ListView({ children, style }: ListViewProps) {
  return (
    <ul className="kos-listview" style={style}>
      {children}
    </ul>
  );
}
