import { ReplaceRule } from "../types";

function parseFrom(from: string): string | RegExp {
  const match = from.match(/^\/(.+)\/([gimsuy]*)$/);
  if (match) {
    return new RegExp(match[1], match[2]);
  }
  return from;
}

export function applyReplace(content: string, rules: ReplaceRule[]): string {
  let result = content;
  for (const rule of rules) {
    const pattern = parseFrom(rule.from);
    if (typeof pattern === "string") {
      result = result.split(pattern).join(rule.to);
    } else {
      result = result.replace(pattern, rule.to);
    }
  }
  return result;
}
