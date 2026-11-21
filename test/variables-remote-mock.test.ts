import { afterEach, describe, expect, it, vi } from 'vitest';

// Sources and template engines can throw arbitrary values and report files
// under any key; simulate those cases instead of reaching for real backends.
vi.mock('../src/sources', () => ({ fetchSource: vi.fn() }));
vi.mock('../src/processors/template', () => ({ applyTemplate: vi.fn() }));

import { fetchSource } from '../src/sources';
import { applyTemplate } from '../src/processors/template';
import { resolveVariableEntry } from '../src/variables-remote';
import { resolveEnvironmentEntry } from '../src/environment';

const fetchMock = vi.mocked(fetchSource);
const templateMock = vi.mocked(applyTemplate);

const vars = Object.create(null) as Record<string, string>;

function oneFile(key: string, content: string): void {
  fetchMock.mockResolvedValue({
    files: new Map([[key, Buffer.from(content, 'utf8')]]),
  } as Awaited<ReturnType<typeof fetchSource>>);
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('resolveVariableEntry — simulated sources', () => {
  it('reports a non-Error thrown by the source', async () => {
    fetchMock.mockRejectedValue('boom');
    await expect(
      resolveVariableEntry('v', { src: 'x' }, vars, '.'),
    ).rejects.toThrow('variables.v: failed to fetch source: boom');
  });

  it('passes no source path to the template when the source key is empty', async () => {
    oneFile('', 'raw');
    templateMock.mockResolvedValue(' rendered ');
    await expect(
      resolveVariableEntry('v', { src: 'x', template: 'ejs' }, vars, '.'),
    ).resolves.toBe('rendered');
    expect(templateMock).toHaveBeenCalledWith('raw', 'ejs', vars, undefined);
  });

  it('reports a non-Error thrown by the template engine', async () => {
    oneFile('a.txt', 'raw');
    templateMock.mockRejectedValue('bad template');
    await expect(
      resolveVariableEntry('v', { src: 'x', template: 'ejs' }, vars, '.'),
    ).rejects.toThrow('variables.v: template rendering failed: bad template');
  });
});

describe('resolveEnvironmentEntry — simulated sources', () => {
  it('reports a non-Error thrown by the source', async () => {
    fetchMock.mockRejectedValue('boom');
    await expect(
      resolveEnvironmentEntry('E', { src: 'x' }, vars, '.'),
    ).rejects.toThrow('environment.E: failed to fetch source: boom');
  });
});
