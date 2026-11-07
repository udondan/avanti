import * as path from 'path';
import Handlebars from 'handlebars';
import nunjucks from 'nunjucks';
import { Liquid } from 'liquidjs';
import * as ejs from 'ejs';
import Mustache from 'mustache';
import { Eta } from 'eta';
import { Variables, TemplateEngine } from '../types';

// avanti renders config files, not HTML — disable all engine HTML escaping
Mustache.escape = String;

const EXTENSION_MAP: Record<string, TemplateEngine> = {
  '.hbs': 'handlebars',
  '.handlebars': 'handlebars',
  '.njk': 'nunjucks',
  '.j2': 'nunjucks',
  '.jinja': 'nunjucks',
  '.jinja2': 'nunjucks',
  '.liquid': 'liquidjs',
  '.ejs': 'ejs',
  '.eta': 'eta',
  '.mustache': 'mustache',
  '.mst': 'mustache',
};

let liquid: Liquid | undefined;
let nunjucksEnv: nunjucks.Environment | undefined;
let eta: Eta | undefined;

function getLiquid(): Liquid {
  liquid ??= new Liquid({
    strictVariables: true,
    strictFilters: true,
  });
  return liquid;
}

function getNunjucksEnv(): nunjucks.Environment {
  nunjucksEnv ??= new nunjucks.Environment(null, {
    throwOnUndefined: true,
    autoescape: false,
  });
  return nunjucksEnv;
}

function getEta(): Eta {
  eta ??= new Eta({
    useWith: true,
    autoTrim: false,
    autoEscape: false,
  });
  return eta;
}

type Renderer = (content: string, vars: Variables) => string | Promise<string>;

const RENDERERS = new Map<string, Renderer>([
  [
    'handlebars',
    (content, vars) =>
      Handlebars.compile(content, { strict: true, noEscape: true })(vars),
  ],
  ['nunjucks', (content, vars) => getNunjucksEnv().renderString(content, vars)],
  [
    'liquidjs',
    async (content, vars) =>
      String(await getLiquid().parseAndRender(content, vars)),
  ],
  ['ejs', (content, vars) => ejs.render(content, vars, { escape: String })],
  ['mustache', (content, vars) => Mustache.render(content, vars)],
  [
    'eta',
    async (content, vars) =>
      String(await getEta().renderStringAsync(content, vars)),
  ],
]);

function resolveEngine(
  spec: TemplateEngine | true,
  srcPath?: string,
): TemplateEngine {
  if (spec !== true) {
    return spec === 'jinja2' ? 'nunjucks' : spec;
  }
  if (srcPath) {
    const engine = EXTENSION_MAP[path.extname(srcPath).toLowerCase()];
    if (engine) return engine;
  }
  throw new Error(
    `template: true requires a recognized extension ` +
      `(${Object.keys(EXTENSION_MAP).join(', ')}). ` +
      `Got: "${srcPath ?? '(no path)'}"`,
  );
}

export async function applyTemplate(
  content: string,
  spec: TemplateEngine | true,
  vars: Variables,
  srcPath?: string,
): Promise<string> {
  const engine = resolveEngine(spec, srcPath);
  const render = RENDERERS.get(engine);
  if (!render) {
    throw new Error(`Unsupported template engine: ${engine}`);
  }
  return render(content, vars);
}
