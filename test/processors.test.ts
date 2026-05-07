import { describe, it, expect } from 'vitest';
import { applyReplace } from '../src/processors/replace';
import { applyPost } from '../src/processors/post';

describe('applyReplace', () => {
  it('replaces plain string', () => {
    expect(applyReplace('hello world', [{ from: 'world', to: 'there' }])).toBe(
      'hello there',
    );
  });

  it('replaces all occurrences of plain string', () => {
    expect(applyReplace('aaa', [{ from: 'a', to: 'b' }])).toBe('bbb');
  });

  it('replaces with regex', () => {
    expect(applyReplace('foo123bar', [{ from: '/[0-9]+/', to: 'NUM' }])).toBe(
      'fooNUMbar',
    );
  });

  it('replaces with regex flags', () => {
    expect(applyReplace('Hello HELLO', [{ from: '/hello/gi', to: 'hi' }])).toBe(
      'hi hi',
    );
  });

  it('applies multiple rules in order', () => {
    expect(
      applyReplace('abc', [
        { from: 'a', to: 'x' },
        { from: 'b', to: 'y' },
      ]),
    ).toBe('xyc');
  });
});

describe('applyPost', () => {
  it('pipes content through shell script', () => {
    const result = applyPost('hello\n', 'tr a-z A-Z');
    expect(result).toBe('HELLO\n');
  });

  it('throws on non-zero exit', () => {
    expect(() => applyPost('x', 'exit 1')).toThrow(
      'post script exited with code 1',
    );
  });

  it('resolves variables in the script', () => {
    const result = applyPost('hello\n', 'tr $from $to', {
      from: 'a-z',
      to: 'A-Z',
    });
    expect(result).toBe('HELLO\n');
  });

  it('throws on undefined variable in script', () => {
    expect(() => applyPost('x', 'echo $missing', {})).toThrow(
      'Undefined variable: $missing',
    );
  });
});

describe('applyReplace with variables', () => {
  it('resolves variable in "to"', () => {
    expect(
      applyReplace('hello {NAME}', [{ from: '{NAME}', to: '$name' }], {
        name: 'world',
      }),
    ).toBe('hello world');
  });

  it('resolves variable in "from"', () => {
    expect(
      applyReplace('hello PLACEHOLDER', [{ from: '$ph', to: 'world' }], {
        ph: 'PLACEHOLDER',
      }),
    ).toBe('hello world');
  });

  it('throws on undefined variable in replace rule', () => {
    expect(() =>
      applyReplace('x', [{ from: 'x', to: '$missing' }], {}),
    ).toThrow('Undefined variable: $missing');
  });
});
