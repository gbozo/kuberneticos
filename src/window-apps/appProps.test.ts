import { describe, expect, it } from 'vitest';
import { commandFromAnnotation, stringListProp, stringProp } from './appProps';

describe('commandFromAnnotation', () => {
  it('splits a single command unchanged', () => {
    expect(commandFromAnnotation('firefox')).toEqual(['firefox']);
  });

  it('splits space-separated arguments', () => {
    expect(commandFromAnnotation('code --disable-gpu .')).toEqual(['code', '--disable-gpu', '.']);
  });

  it('collapses runs of whitespace', () => {
    expect(commandFromAnnotation('  xterm   -e  sh  ')).toEqual(['xterm', '-e', 'sh']);
  });

  it('returns an empty argv for blank annotations', () => {
    expect(commandFromAnnotation('   ')).toEqual([]);
  });
});

describe('stringProp', () => {
  it('reads string values and rejects everything else', () => {
    expect(stringProp({ pod: 'web-1' }, 'pod')).toBe('web-1');
    expect(stringProp({ pod: 7 }, 'pod')).toBeUndefined();
    expect(stringProp({}, 'pod')).toBeUndefined();
  });
});

describe('stringListProp', () => {
  it('reads homogeneous string arrays', () => {
    expect(stringListProp({ command: ['xeyes'] }, 'command')).toEqual(['xeyes']);
  });

  it('rejects arrays with non-string entries and non-arrays', () => {
    expect(stringListProp({ command: ['a', 3] }, 'command')).toBeUndefined();
    expect(stringListProp({ command: 'xeyes' }, 'command')).toBeUndefined();
    expect(stringListProp({}, 'command')).toBeUndefined();
  });
});
