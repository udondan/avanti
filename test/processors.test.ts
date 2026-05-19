import { describe, it, expect } from 'vitest';
import { applyReplace } from '../src/processors/replace';
import { applyPost } from '../src/processors/post';
import { applyTemplate } from '../src/processors/template';
import { isWindows } from '../src/shell';

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
    const script = isWindows
      ? '[Console]::Out.Write([Console]::In.ReadToEnd().ToUpper())'
      : 'tr a-z A-Z';
    const result = applyPost('hello\n', script);
    expect(result).toBe('HELLO\n');
  });

  it('throws on non-zero exit', () => {
    expect(() => applyPost('x', 'exit 1')).toThrow(
      'post script exited with code 1',
    );
  });

  it('resolves variables in the script', () => {
    if (isWindows) {
      // Use a PS-compatible command that still exercises avanti variable substitution
      const result = applyPost('', '[Console]::Out.Write($msg)', {
        msg: 'hello',
      });
      expect(result).toBe('hello');
    } else {
      const result = applyPost('hello\n', 'tr $from $to', {
        from: 'a-z',
        to: 'A-Z',
      });
      expect(result).toBe('HELLO\n');
    }
  });

  it('throws on undefined variable in script', () => {
    expect(() => applyPost('x', 'echo $missing', {})).toThrow(
      'Undefined variable: $missing',
    );
  });

  it('shell-quotes variable values to prevent metachar injection', () => {
    if (isWindows) {
      // Without quoting, "; Write-Output injected" would run as a second command.
      const result = applyPost('', '[Console]::Out.Write($val)', {
        val: 'hello; Write-Output injected',
      });
      expect(result).toBe('hello; Write-Output injected');
    } else {
      // Without quoting, "hello; echo injected" would run two commands.
      const result = applyPost('', "printf '%s' $val", {
        val: 'hello; echo injected',
      });
      expect(result).toBe('hello; echo injected');
    }
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

describe('applyTemplate', () => {
  const vars = { name: 'world', greeting: 'Hello' };

  it('renders handlebars template', async () => {
    expect(await applyTemplate('Hello {{name}}!', 'handlebars', vars)).toBe(
      'Hello world!',
    );
  });

  it('renders nunjucks template', async () => {
    expect(await applyTemplate('Hello {{ name }}!', 'nunjucks', vars)).toBe(
      'Hello world!',
    );
  });

  it('treats jinja2 as an alias for nunjucks', async () => {
    expect(
      await applyTemplate('{{ greeting }} {{ name }}!', 'jinja2', vars),
    ).toBe('Hello world!');
  });

  it('renders liquidjs template', async () => {
    expect(await applyTemplate('Hello {{ name }}!', 'liquidjs', vars)).toBe(
      'Hello world!',
    );
  });

  it('renders ejs template', async () => {
    expect(await applyTemplate('Hello <%= name %>!', 'ejs', vars)).toBe(
      'Hello world!',
    );
  });

  it('renders mustache template', async () => {
    expect(await applyTemplate('Hello {{name}}!', 'mustache', vars)).toBe(
      'Hello world!',
    );
  });

  it('renders eta template without it. prefix', async () => {
    expect(await applyTemplate('Hello <%= name %>!', 'eta', vars)).toBe(
      'Hello world!',
    );
  });

  it('auto-detects handlebars from .hbs extension', async () => {
    expect(await applyTemplate('{{name}}', true, vars, 'template.hbs')).toBe(
      'world',
    );
  });

  it('auto-detects handlebars from .handlebars extension', async () => {
    expect(
      await applyTemplate('{{name}}', true, vars, 'template.handlebars'),
    ).toBe('world');
  });

  it('auto-detects nunjucks from .njk extension', async () => {
    expect(await applyTemplate('{{ name }}', true, vars, 'template.njk')).toBe(
      'world',
    );
  });

  it('auto-detects nunjucks from .j2 extension', async () => {
    expect(await applyTemplate('{{ name }}', true, vars, 'template.j2')).toBe(
      'world',
    );
  });

  it('auto-detects nunjucks from .jinja2 extension', async () => {
    expect(
      await applyTemplate('{{ name }}', true, vars, 'template.jinja2'),
    ).toBe('world');
  });

  it('auto-detects liquidjs from .liquid extension', async () => {
    expect(
      await applyTemplate('{{ name }}', true, vars, 'template.liquid'),
    ).toBe('world');
  });

  it('auto-detects ejs from .ejs extension', async () => {
    expect(await applyTemplate('<%= name %>', true, vars, 'template.ejs')).toBe(
      'world',
    );
  });

  it('auto-detects eta from .eta extension', async () => {
    expect(await applyTemplate('<%= name %>', true, vars, 'template.eta')).toBe(
      'world',
    );
  });

  it('auto-detects mustache from .mustache extension', async () => {
    expect(
      await applyTemplate('{{name}}', true, vars, 'template.mustache'),
    ).toBe('world');
  });

  it('auto-detects mustache from .mst extension', async () => {
    expect(await applyTemplate('{{name}}', true, vars, 'template.mst')).toBe(
      'world',
    );
  });

  it('throws on unrecognized extension with template: true', async () => {
    await expect(
      applyTemplate('{{name}}', true, vars, 'template.txt'),
    ).rejects.toThrow('template: true requires a recognized extension');
  });

  it('throws when template: true has no srcPath', async () => {
    await expect(applyTemplate('{{name}}', true, vars)).rejects.toThrow(
      'template: true requires a recognized extension',
    );
  });
});
