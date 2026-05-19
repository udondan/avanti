import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { applyReplace } from '../src/processors/replace';
import { applyPost } from '../src/processors/post';
import { applyTemplate } from '../src/processors/template';
import { isWindows } from '../src/shell';

const FIXTURES = join(__dirname, 'fixtures/templates');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n');
}

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
  // Fixtures at test/fixtures/templates/app.<ext> — multi-variable templates
  // that each produce the same output using each engine's native syntax.
  const fixtureVars = { app: 'myapp', version: '1.2.3' };
  const fixtureOutput =
    'app: myapp\nversion: 1.2.3\nurl: https://example.com/myapp/1.2.3\n';

  it('renders handlebars fixture ({{var}} syntax, variable used twice)', async () => {
    expect(
      await applyTemplate(fixture('app.hbs'), 'handlebars', fixtureVars),
    ).toBe(fixtureOutput);
  });

  it('renders nunjucks fixture ({{ var }} syntax)', async () => {
    expect(
      await applyTemplate(fixture('app.njk'), 'nunjucks', fixtureVars),
    ).toBe(fixtureOutput);
  });

  it('treats jinja2 as alias for nunjucks (same fixture, same output)', async () => {
    expect(await applyTemplate(fixture('app.njk'), 'jinja2', fixtureVars)).toBe(
      fixtureOutput,
    );
  });

  it('renders liquidjs fixture ({{ var }} syntax)', async () => {
    expect(
      await applyTemplate(fixture('app.liquid'), 'liquidjs', fixtureVars),
    ).toBe(fixtureOutput);
  });

  it('renders ejs fixture (<%= var %> syntax)', async () => {
    expect(await applyTemplate(fixture('app.ejs'), 'ejs', fixtureVars)).toBe(
      fixtureOutput,
    );
  });

  it('renders mustache fixture ({{var}} syntax)', async () => {
    expect(
      await applyTemplate(fixture('app.mustache'), 'mustache', fixtureVars),
    ).toBe(fixtureOutput);
  });

  it('renders eta fixture (<%= var %> syntax, no it. prefix)', async () => {
    expect(await applyTemplate(fixture('app.eta'), 'eta', fixtureVars)).toBe(
      fixtureOutput,
    );
  });

  // Auto-detection by extension
  it('auto-detects handlebars from .hbs extension', async () => {
    expect(
      await applyTemplate(fixture('app.hbs'), true, fixtureVars, 'app.hbs'),
    ).toBe(fixtureOutput);
  });

  it('auto-detects handlebars from .handlebars extension', async () => {
    expect(
      await applyTemplate(
        fixture('app.hbs'),
        true,
        fixtureVars,
        'app.handlebars',
      ),
    ).toBe(fixtureOutput);
  });

  it('auto-detects nunjucks from .njk extension', async () => {
    expect(
      await applyTemplate(fixture('app.njk'), true, fixtureVars, 'app.njk'),
    ).toBe(fixtureOutput);
  });

  it('auto-detects nunjucks from .j2 extension', async () => {
    expect(
      await applyTemplate(fixture('app.njk'), true, fixtureVars, 'app.j2'),
    ).toBe(fixtureOutput);
  });

  it('auto-detects nunjucks from .jinja2 extension', async () => {
    expect(
      await applyTemplate(fixture('app.njk'), true, fixtureVars, 'app.jinja2'),
    ).toBe(fixtureOutput);
  });

  it('auto-detects liquidjs from .liquid extension', async () => {
    expect(
      await applyTemplate(
        fixture('app.liquid'),
        true,
        fixtureVars,
        'app.liquid',
      ),
    ).toBe(fixtureOutput);
  });

  it('auto-detects ejs from .ejs extension', async () => {
    expect(
      await applyTemplate(fixture('app.ejs'), true, fixtureVars, 'app.ejs'),
    ).toBe(fixtureOutput);
  });

  it('auto-detects eta from .eta extension', async () => {
    expect(
      await applyTemplate(fixture('app.eta'), true, fixtureVars, 'app.eta'),
    ).toBe(fixtureOutput);
  });

  it('auto-detects mustache from .mustache extension', async () => {
    expect(
      await applyTemplate(
        fixture('app.mustache'),
        true,
        fixtureVars,
        'app.mustache',
      ),
    ).toBe(fixtureOutput);
  });

  it('auto-detects mustache from .mst extension', async () => {
    expect(
      await applyTemplate(
        fixture('app.mustache'),
        true,
        fixtureVars,
        'app.mst',
      ),
    ).toBe(fixtureOutput);
  });

  // Error cases
  it('throws on unrecognized extension with template: true', async () => {
    await expect(
      applyTemplate(fixture('app.hbs'), true, fixtureVars, 'app.txt'),
    ).rejects.toThrow('template: true requires a recognized extension');
  });

  it('throws when template: true has no srcPath', async () => {
    await expect(
      applyTemplate(fixture('app.hbs'), true, fixtureVars),
    ).rejects.toThrow('template: true requires a recognized extension');
  });
});
