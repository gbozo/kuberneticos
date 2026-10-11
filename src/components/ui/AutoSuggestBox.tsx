import { useId, useState, type ChangeEvent } from 'react';

export interface AutoSuggestBoxProps {
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
  options?: readonly string[];
}

export function AutoSuggestBox({ placeholder, value, onChange, options }: AutoSuggestBoxProps) {
  const listId = useId();
  const [internal, setInternal] = useState('');
  const isControlled = value !== undefined;
  const current = isControlled ? value : internal;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    if (!isControlled) {
      setInternal(next);
    }
    onChange?.(next);
  };

  return (
    <div className="kos-autosuggest">
      <input
        className="kos-autosuggest__input"
        type="text"
        list={listId}
        placeholder={placeholder}
        value={current}
        onChange={handleChange}
      />
      {options && options.length > 0 ? (
        <datalist id={listId}>
          {options.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}
