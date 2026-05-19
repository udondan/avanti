import * as path from 'path';
import Handlebars from 'handlebars';
import nunjucks from 'nunjucks';
import { Liquid } from 'liquidjs';
import * as ejs from 'ejs';
import Mustache from 'mustache';
import { Eta } from 'eta';
import { Variables, TemplateEngine } from '../types';

export const VALID_TEMPLATE_ENGINES: TemplateEngine[] = [
  'handlebars',
  'nunjucks',
  'jinja2',
  'liquidjs',
  'ejs',
  'mustache',
  'eta',
];

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

const liquid = new Liquid();
const eta = new Eta({ useWith: true, autoTrim: false });

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
      return Handlebars.compile(content)(vars);
    case 'nunjucks':
      return nunjucks.renderString(content, vars);
    case 'liquidjs':
      return String(await liquid.parseAndRender(content, vars));
    case 'ejs':
      return ejs.render(content, vars);
    case 'mustache':
      return Mustache.render(content, vars);
    case 'eta':
      return String(await eta.renderStringAsync(content, vars));
    default:
      throw new Error(`Unsupported template engine: ${engine as string}`);
  }
}
