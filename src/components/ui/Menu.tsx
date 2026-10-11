import type { KeyboardEvent, ReactNode } from 'react';
import { Icon, type KosIconName } from './Icon';

export interface MenuProps {
  children: ReactNode;
  className?: string;
}

export function Menu({ children, className }: MenuProps) {
  return (
    <div role="menu" className={className ? `kos-menu ${className}` : 'kos-menu'}>
      {children}
    </div>
  );
}

export interface MenuItemProps {
  label: string;
  icon?: KosIconName;
  disabled?: boolean;
  onClick?: () => void;
  children?: ReactNode;
}

export function MenuItem({ label, icon, disabled = false, onClick, children }: MenuItemProps) {
  const handleActivate = () => {
    if (!disabled) {
      onClick?.();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleActivate();
    }
  };

  return (
    <div
      role="menuitem"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      className={disabled ? 'kos-menu-item is-disabled' : 'kos-menu-item'}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
    >
      <span className="kos-menu-item__row">
        <span className="kos-menu-item__icon">{icon ? <Icon name={icon} size={16} /> : null}</span>
        <span className="kos-menu-item__label">{label}</span>
        {children ? (
          <Icon name="chevron-right" size={12} className="kos-menu-item__chevron" />
        ) : null}
      </span>
      {children ? <div className="kos-menu-item__children">{children}</div> : null}
    </div>
  );
}
