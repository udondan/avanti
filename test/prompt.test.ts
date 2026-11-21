import { afterEach, describe, expect, it, vi } from 'vitest';

const answers: string[] = [];
const close = vi.fn();
vi.mock('readline', () => ({
  createInterface: vi.fn(() => ({
    question: (_q: string, cb: (answer: string) => void): void =>
      cb(answers.shift() ?? ''),
    close,
  })),
}));

import * as readline from 'readline';
import { confirm } from '../src/prompt';

afterEach(() => {
  answers.length = 0;
  close.mockClear();
});

describe('confirm', () => {
  it.each([
    ['y', true],
    ['Y', true],
    [' yes ', true],
    ['YES', true],
    ['n', false],
    ['', false],
    ['yep', false],
  ])('answer %j → %s', async (answer, expected) => {
    answers.push(answer);
    await expect(confirm('Apply? ')).resolves.toBe(expected);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reads from stdin and writes to stdout', async () => {
    answers.push('y');
    await confirm('Q? ');
    expect(readline.createInterface).toHaveBeenCalledWith({
      input: process.stdin,
      output: process.stdout,
    });
  });
});
