export interface SeparatorProps {
  direction?: 'row' | 'column';
}

export function Separator({ direction = 'row' }: SeparatorProps) {
  return (
    <div
      className={`kos-separator kos-separator--${direction}`}
      role="separator"
      aria-orientation={direction === 'row' ? 'horizontal' : 'vertical'}
    />
  );
}
