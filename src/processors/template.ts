import * as path from 'path';
import Handlebars from 'handlebars';
import nunjucks from 'nunjucks';
import { Liquid } from 'liquidjs';
import * as ejs from 'ejs';
import Mustache from 'mustache';
import { Eta } from 'eta';
import { Variables, TemplateEngine, VALID_TEMPLATE_ENGINES } from '../types';

export { VALID_TEMPLATE_ENGINES };

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
  return (liquid ??= new Liquid({
    strictVariables: true,
    strictFilters: true,
  }));
}

function getNunjucksEnv(): nunjucks.Environment {
  return (nunjucksEnv ??= new nunjucks.Environment(null, {
    throwOnUndefined: true,
  }));
}

function getEta(): Eta {
  return (eta ??= new Eta({ useWith: true, autoTrim: false }));
}

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
  switch (engine) {
    case 'handlebars':
      return Handlebars.compile(content, { strict: true })(vars);
    case 'nunjucks':
      return getNunjucksEnv().renderString(content, vars);
    case 'liquidjs':
      return String(await getLiquid().parseAndRender(content, vars));
    case 'ejs':
      return ejs.render(content, vars);
    case 'mustache':
      return Mustache.render(content, vars);
    case 'eta':
      return String(await getEta().renderStringAsync(content, vars));
    default:
      throw new Error(`Unsupported template engine: ${engine as string}`);
  }
}
