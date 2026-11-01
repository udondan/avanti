// Turns the child-process lcov from c8 (coverage/child-raw/lcov.info) into
// coverage/child/lcov.info, which Codecov merges with Vitest's report.
//
// c8 counts every source line, including comments and type declarations.
// Vitest only counts executable lines, and it lists every file in src/. Lines
// Vitest doesn't count are dropped here, so they don't show up as misses on
// Codecov. Only line hits are kept: branch data of the two tools doesn't line
// up.
import * as fs from 'fs';
import * as path from 'path';

const VITEST = 'coverage/lcov.info';
const RAW = 'coverage/child-raw/lcov.info';
const OUT = 'coverage/child/lcov.info';

function parse(file: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let lines = new Map<number, number>();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      lines = new Map();
      files.set(path.resolve(line.slice(3)), lines);
    } else if (line.startsWith('DA:')) {
      const [n, hits] = line.slice(3).split(',').map(Number);
      lines.set(n, Math.max(lines.get(n) ?? 0, hits));
    }
  }
  return files;
}

const executable = parse(VITEST);
const child = parse(RAW);

const out: string[] = [];
for (const [file, lines] of child) {
  const keep = executable.get(file);
  if (!keep) continue;
  out.push('TN:', `SF:${path.relative(process.cwd(), file)}`);
  let found = 0;
  let hit = 0;
  for (const [n, hits] of [...lines].sort((a, b) => a[0] - b[0])) {
    if (!keep.has(n)) continue;
    out.push(`DA:${n},${hits}`);
    found++;
    if (hits > 0) hit++;
  }
  out.push(`LF:${found}`, `LH:${hit}`, 'end_of_record');
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n') + '\n');
console.log(`Wrote ${OUT} (${child.size} files)`);
