import { Icon, type KosIconName } from './Icon';

export interface AppBarButtonProps {
  icon?: KosIconName;
  label?: string;
  onClick?: () => void;
  active?: boolean;
  title?: string;
}

export function AppBarButton({ icon, label, onClick, active = false, title }: AppBarButtonProps) {
  const className = active ? 'kos-appbar-button is-active' : 'kos-appbar-button';
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      title={title}
      aria-pressed={active}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      {label ? <span className="kos-appbar-button__label">{label}</span> : null}
    </button>
  );
}
