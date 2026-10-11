import { useState, type ChangeEvent } from 'react';

export interface CheckBoxProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
}

export function CheckBox({ checked, defaultChecked = false, onChange, label }: CheckBoxProps) {
  const [internal, setInternal] = useState(defaultChecked);
  const isControlled = checked !== undefined;
  const value = isControlled ? checked : internal;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.checked;
    if (!isControlled) {
      setInternal(next);
    }
    onChange?.(next);
  };

  return (
    <label className="kos-checkbox">
      <input type="checkbox" checked={value} onChange={handleChange} />
      {label ? <span className="kos-checkbox__label">{label}</span> : null}
    </label>
  );
}
