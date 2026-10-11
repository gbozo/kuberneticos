import { useState } from 'react';

export interface ToggleProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
}

export function Toggle({ checked, defaultChecked = false, onChange, label }: ToggleProps) {
  const [internal, setInternal] = useState(defaultChecked);
  const isControlled = checked !== undefined;
  const value = isControlled ? checked : internal;

  const handleClick = () => {
    const next = !value;
    if (!isControlled) {
      setInternal(next);
    }
    onChange?.(next);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className={value ? 'kos-toggle is-checked' : 'kos-toggle'}
      onClick={handleClick}
    >
      <span className="kos-toggle__track">
        <span className="kos-toggle__thumb" />
      </span>
      {label ? <span className="kos-toggle__label">{label}</span> : null}
    </button>
  );
}
