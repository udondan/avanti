/** Adds trailing commas before closing brackets of pretty-printed JSON. */

const NO_COMMA_AFTER = new Set(['', ',', '{', '[']);

function isCommentStart(trimmed: string): boolean {
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*')
  );
}

// The next line that is neither blank nor a comment, trimmed.
function nextSignificantLine(lines: string[], from: number): string | null {
  for (let j = from; j < lines.length; j++) {
    const t = lines[j].trim();
    if (t !== '' && !isCommentStart(t)) return t;
  }
  return null;
}

function closesContainer(trimmed: string | null): boolean {
  return (
    trimmed !== null && (trimmed.startsWith('}') || trimmed.startsWith(']'))
  );
}

function findLineCommentIndex(line: string): number {
  let inString = false;
  let escape = false;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (escape) {
      escape = false;
    } else if (ch === '\\' && inString) {
      escape = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString && ch === '/' && line[i + 1] === '/') {
      return i;
    }
  }
  return -1;
}

// The line with a comma after its value, or null when it takes none.
function withTrailingComma(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || isCommentStart(trimmed)) return null;
  // Find the position of a line comment, if any
  const commentIdx = findLineCommentIndex(line);
  const effectiveEnd =
    commentIdx >= 0 ? line.substring(0, commentIdx).trimEnd() : line.trimEnd();
  if (NO_COMMA_AFTER.has(effectiveEnd.slice(-1))) return null;
  return commentIdx >= 0
    ? effectiveEnd + ',' + ' ' + line.substring(commentIdx).trimStart()
    : effectiveEnd + ',';
}

export function addTrailingCommas(json: string): string {
  const lines = json.split('\n');
  return lines
    .map((line, i) =>
      closesContainer(nextSignificantLine(lines, i + 1))
        ? (withTrailingComma(line) ?? line)
        : line,
    )
    .join('\n');
}
