import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect } from 'vitest';
import { applyReplace } from '../src/processors/replace';
import { applyWriteHook, runHook } from '../src/processors/on';
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

describe('applyWriteHook', () => {
  it('pipes content through shell script', () => {
    const script = isWindows
      ? '[Console]::Out.Write([Console]::In.ReadToEnd().ToUpper())'
      : 'tr a-z A-Z';
    const result = applyWriteHook('hello\n', script);
    expect(result).toBe('HELLO\n');
  });

  it('throws on non-zero exit', () => {
    expect(() => applyWriteHook('x', 'exit 1')).toThrow(
      'on.write script exited with code 1',
    );
  });

  it('resolves variables in the script', () => {
    if (isWindows) {
      const result = applyWriteHook('', '[Console]::Out.Write($msg)', {
        msg: 'hello',
      });
      expect(result).toBe('hello');
    } else {
      const result = applyWriteHook('hello\n', 'tr $from $to', {
        from: 'a-z',
        to: 'A-Z',
      });
      expect(result).toBe('HELLO\n');
    }
  });

  it('throws on undefined variable in script', () => {
    expect(() => applyWriteHook('x', 'echo $missing', {})).toThrow(
      'Undefined variable: $missing',
    );
  });

  it('shell-quotes variable values to prevent metachar injection', () => {
    if (isWindows) {
      const result = applyWriteHook('', '[Console]::Out.Write($val)', {
        val: 'hello; Write-Output injected',
      });
      expect(result).toBe('hello; Write-Output injected');
    } else {
      const result = applyWriteHook('', "printf '%s' $val", {
        val: 'hello; echo injected',
      });
      expect(result).toBe('hello; echo injected');
    }
  });
});

describe('runHook', () => {
  it('runs side-effect script without content transform', () => {
    expect(() => runHook(isWindows ? 'exit 0' : 'true')).not.toThrow();
  });

  it('throws on non-zero exit', () => {
    expect(() => runHook('exit 1')).toThrow('hook script exited with code 1');
  });

  it('receives AVANTI_TARGET env var', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avanti-hook-'));
    try {
      const out = join(dir, 'out.txt');
      if (isWindows) {
        // Windows prelude maps $AVANTI_TARGET = $env:AVANTI_TARGET; so PS syntax works
        // Escape single quotes in path for PS single-quoted string literals.
        const psSafeOut = out.replace(/'/g, "''");
        runHook(
          `[System.IO.File]::WriteAllText('${psSafeOut}', $AVANTI_TARGET)`,
          {
            AVANTI_TARGET: '/some/path',
          },
        );
      } else {
        runHook(`printf '%s' "$AVANTI_TARGET" > "${out}"`, {
          AVANTI_TARGET: '/some/path',
        });
      }
      expect(readFileSync(out, 'utf8')).toBe('/some/path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

  it('auto-detects nunjucks from .jinja extension', async () => {
    expect(
      await applyTemplate(fixture('app.njk'), true, fixtureVars, 'app.jinja'),
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

  // Undefined variable behavior — consistent with resolveVars which throws on missing $var
  it('handlebars throws on undefined variable', async () => {
    await expect(
      applyTemplate('{{missing}}', 'handlebars', {}),
    ).rejects.toThrow();
  });

  it('nunjucks throws on undefined variable', async () => {
    await expect(
      applyTemplate('{{ missing }}', 'nunjucks', {}),
    ).rejects.toThrow();
  });

  it('liquidjs throws on undefined variable', async () => {
    await expect(
      applyTemplate('{{ missing }}', 'liquidjs', {}),
    ).rejects.toThrow();
  });

  it('ejs throws on undefined variable', async () => {
    await expect(applyTemplate('<%= missing %>', 'ejs', {})).rejects.toThrow();
  });

  it('eta throws on undefined variable', async () => {
    await expect(applyTemplate('<%= missing %>', 'eta', {})).rejects.toThrow();
  });

  it('mustache renders undefined variable as empty string (logic-less, no strict mode)', async () => {
    expect(await applyTemplate('{{missing}}', 'mustache', {})).toBe('');
  });

  // avanti variables come from resolveVariableSpec which uses Object.create(null)
  it('handles null-prototype vars object for all engines', async () => {
    const vars = Object.assign(Object.create(null), {
      app: 'myapp',
      version: '1.2.3',
    }) as Record<string, string>;
    for (const [tmpl, engine] of [
      [fixture('app.hbs'), 'handlebars'],
      [fixture('app.njk'), 'nunjucks'],
      [fixture('app.liquid'), 'liquidjs'],
      [fixture('app.ejs'), 'ejs'],
      [fixture('app.mustache'), 'mustache'],
      [fixture('app.eta'), 'eta'],
    ] as const) {
      expect(
        await applyTemplate(
          tmpl,
          engine as Parameters<typeof applyTemplate>[1],
          vars,
        ),
      ).toBe(fixtureOutput);
    }
  });

  // avanti renders config/text files — variable values must not be HTML-escaped
  it('does not HTML-escape variable values (all engines)', async () => {
    const vars = { val: '<a>&"' };
    const expected = '<a>&"';
    for (const [tmpl, engine] of [
      ['{{val}}', 'handlebars'],
      ['{{ val }}', 'nunjucks'],
      ['{{ val }}', 'liquidjs'],
      ['<%= val %>', 'ejs'],
      ['{{val}}', 'mustache'],
      ['<%= val %>', 'eta'],
    ] as const) {
      expect(
        await applyTemplate(
          tmpl,
          engine as Parameters<typeof applyTemplate>[1],
          vars,
        ),
      ).toBe(expected);
    }
  });

  // Build a null-prototype object — mirrors what deepResolveVars produces at runtime.
  const o = <T extends object>(props: T): T =>
    Object.assign(Object.create(null) as T, props);

  // Complex variables: lists and objects (including nested) passed as template context.
  // Using null-prototype nested objects to match the shape produced by deepResolveVars.
  const complexVars = o({
    servers: [o({ host: 'web1', port: 8080 }), o({ host: 'web2', port: 9090 })],
    db: o({ host: 'pg.internal', creds: o({ user: 'admin' }) }),
  });

  describe('handlebars — complex variables', () => {
    it('accesses an object property', async () => {
      expect(
        await applyTemplate('{{db.host}}', 'handlebars', complexVars),
      ).toBe('pg.internal');
    });

    it('accesses an array element property via .[n]. notation', async () => {
      expect(
        await applyTemplate('{{servers.[0].host}}', 'handlebars', complexVars),
      ).toBe('web1');
    });

    it('accesses a deeply nested property', async () => {
      expect(
        await applyTemplate('{{db.creds.user}}', 'handlebars', complexVars),
      ).toBe('admin');
    });

    it('iterates over an array with #each', async () => {
      expect(
        await applyTemplate(
          '{{#each servers}}{{host}}\n{{/each}}',
          'handlebars',
          complexVars,
        ),
      ).toBe('web1\nweb2\n');
    });
  });

  describe('nunjucks — complex variables', () => {
    it('accesses an object property', async () => {
      expect(
        await applyTemplate('{{ db.host }}', 'nunjucks', complexVars),
      ).toBe('pg.internal');
    });

    it('accesses an array element property', async () => {
      expect(
        await applyTemplate('{{ servers[0].host }}', 'nunjucks', complexVars),
      ).toBe('web1');
    });

    it('accesses a deeply nested property', async () => {
      expect(
        await applyTemplate('{{ db.creds.user }}', 'nunjucks', complexVars),
      ).toBe('admin');
    });

    it('iterates over an array with for loop', async () => {
      expect(
        await applyTemplate(
          '{% for s in servers %}{{ s.host }}\n{% endfor %}',
          'nunjucks',
          complexVars,
        ),
      ).toBe('web1\nweb2\n');
    });
  });

  describe('jinja2 (nunjucks alias) — complex variables', () => {
    it('accesses an object property', async () => {
      expect(await applyTemplate('{{ db.host }}', 'jinja2', complexVars)).toBe(
        'pg.internal',
      );
    });

    it('iterates over an array with for loop', async () => {
      expect(
        await applyTemplate(
          '{% for s in servers %}{{ s.host }}\n{% endfor %}',
          'jinja2',
          complexVars,
        ),
      ).toBe('web1\nweb2\n');
    });
  });

  describe('liquidjs — complex variables', () => {
    it('accesses an object property', async () => {
      expect(
        await applyTemplate('{{ db.host }}', 'liquidjs', complexVars),
      ).toBe('pg.internal');
    });

    it('accesses an array element property', async () => {
      expect(
        await applyTemplate('{{ servers[0].host }}', 'liquidjs', complexVars),
      ).toBe('web1');
    });

    it('accesses a deeply nested property', async () => {
      expect(
        await applyTemplate('{{ db.creds.user }}', 'liquidjs', complexVars),
      ).toBe('admin');
    });

    it('iterates over an array with for loop', async () => {
      expect(
        await applyTemplate(
          '{% for s in servers %}{{ s.host }}\n{% endfor %}',
          'liquidjs',
          complexVars,
        ),
      ).toBe('web1\nweb2\n');
    });
  });

  describe('ejs — complex variables', () => {
    it('accesses an object property', async () => {
      expect(await applyTemplate('<%= db.host %>', 'ejs', complexVars)).toBe(
        'pg.internal',
      );
    });

    it('accesses an array element property', async () => {
      expect(
        await applyTemplate('<%= servers[0].host %>', 'ejs', complexVars),
      ).toBe('web1');
    });

    it('accesses a deeply nested property', async () => {
      expect(
        await applyTemplate('<%= db.creds.user %>', 'ejs', complexVars),
      ).toBe('admin');
    });

    it('iterates over an array with for-of loop', async () => {
      expect(
        await applyTemplate(
          '<% for (const s of servers) { %><%= s.host %>\n<% } %>',
          'ejs',
          complexVars,
        ),
      ).toBe('web1\nweb2\n');
    });
  });

  describe('mustache — complex variables', () => {
    it('accesses an object property via dot notation', async () => {
      expect(await applyTemplate('{{db.host}}', 'mustache', complexVars)).toBe(
        'pg.internal',
      );
    });

    it('accesses a deeply nested property', async () => {
      expect(
        await applyTemplate('{{db.creds.user}}', 'mustache', complexVars),
      ).toBe('admin');
    });

    it('iterates over an array with section', async () => {
      expect(
        await applyTemplate(
          '{{#servers}}{{host}}\n{{/servers}}',
          'mustache',
          complexVars,
        ),
      ).toBe('web1\nweb2\n');
    });
  });

  describe('eta — complex variables', () => {
    it('accesses an object property', async () => {
      expect(await applyTemplate('<%= db.host %>', 'eta', complexVars)).toBe(
        'pg.internal',
      );
    });

    it('accesses an array element property', async () => {
      expect(
        await applyTemplate('<%= servers[0].host %>', 'eta', complexVars),
      ).toBe('web1');
    });

    it('accesses a deeply nested property', async () => {
      expect(
        await applyTemplate('<%= db.creds.user %>', 'eta', complexVars),
      ).toBe('admin');
    });

    it('iterates over an array with for-of loop', async () => {
      expect(
        await applyTemplate(
          '<% for (const s of servers) { %><%= s.host %>\n<% } %>',
          'eta',
          complexVars,
        ),
      ).toBe('web1\nweb2\n');
    });
  });
});
