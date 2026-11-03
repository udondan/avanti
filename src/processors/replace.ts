import { ReplaceRule, Variables } from '../types';
import { resolveVars } from '../variables';

function parseFrom(from: string): string | RegExp {
  const match = from.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    return new RegExp(match[1], match[2]);
  }
  return from;
}

export function applyReplace(
  content: string,
  rules: ReplaceRule[],
  vars: Variables = {},
): string {
  let result = content;
  for (const rule of rules) {
    const from = resolveVars(rule.from, vars);
    const to = resolveVars(rule.to, vars);
    const pattern = parseFrom(from);
    if (typeof pattern === 'string') {
      result = result.split(pattern).join(to);
    } else {
      result = result.replace(pattern, to);
    }
  }
  return result;
}
