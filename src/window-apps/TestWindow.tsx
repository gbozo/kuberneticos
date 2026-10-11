import { useState, type CSSProperties } from 'react';
import { AutoSuggestBox, Icon, Separator, Toggle } from '../components/ui';
import type { WindowAppProps } from './types';

const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

export function TestWindow({ props }: WindowAppProps) {
  const initialLabel = typeof props.label === 'string' ? props.label : '';
  const [label, setLabel] = useState(initialLabel);
  const [enabled, setEnabled] = useState(false);

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <Icon name="terminal" size={20} />
        <span>{label || 'Test window'}</span>
      </div>
      <Separator />
      <Toggle checked={enabled} onChange={setEnabled} label="Test toggle" />
      <Separator />
      <AutoSuggestBox
        placeholder="Type a value"
        value={label}
        onChange={setLabel}
        options={['alpha', 'beta', 'gamma']}
      />
    </div>
  );
}
