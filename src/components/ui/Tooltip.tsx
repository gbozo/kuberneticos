import type { ReactNode } from 'react';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
}

export function Tooltip({ content, children }: TooltipProps) {
  return (
    <span className="kos-tooltip">
      {children}
      <span className="kos-tooltip__bubble" role="tooltip">
        {content}
      </span>
    </span>
  );
}
