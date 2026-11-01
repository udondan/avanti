// Turns the child-process lcov from c8 (coverage/child-raw/lcov.info) into
// coverage/child/lcov.info, which Codecov merges with Vitest's report.
//
// c8 counts every source line, including comments and type declarations.
// Vitest only counts executable lines, and it lists every file in src/. Lines
// Vitest doesn't count (neither as a line nor as the start of a branch) are
// dropped here, so they don't show up as misses on Codecov. For the remaining
// lines, the line hits and branch hits of c8 are kept, so branches that only
// run in child processes count as taken.
//
// Usage: bun test/setup/merge-child-coverage.ts [coverage-dir]
import * as fs from 'fs';
import * as path from 'path';

const DIR = process.argv[2] ?? 'coverage';
const VITEST = path.join(DIR, 'lcov.info');
const RAW = path.join(DIR, 'child-raw', 'lcov.info');
const OUT = path.join(DIR, 'child', 'lcov.info');

interface FileRecord {
  lines: Map<number, number>;
  branches: Map<number, string[]>;
}

function parse(file: string): Map<string, FileRecord> {
  const files = new Map<string, FileRecord>();
  let rec: FileRecord = { lines: new Map(), branches: new Map() };
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      rec = { lines: new Map(), branches: new Map() };
      files.set(path.resolve(line.slice(3)), rec);
    } else if (line.startsWith('DA:')) {
      const [n, hits] = line.slice(3).split(',').map(Number);
      rec.lines.set(n, Math.max(rec.lines.get(n) ?? 0, hits));
    } else if (line.startsWith('BRDA:')) {
      const n = Number(line.slice(5).split(',')[0]);
      rec.branches.set(n, [...(rec.branches.get(n) ?? []), line]);
    }
  }
  return files;
}

const vitest = parse(VITEST);
const child = parse(RAW);

const out: string[] = [];
for (const [file, rec] of child) {
  const counted = vitest.get(file);
  if (!counted) continue;
  const keep = new Set([...counted.lines.keys(), ...counted.branches.keys()]);
  out.push('TN:', `SF:${path.relative(process.cwd(), file)}`);
  let branchesFound = 0;
  let branchesHit = 0;
  for (const [n, brdas] of [...rec.branches].sort((a, b) => a[0] - b[0])) {
    if (!keep.has(n)) continue;
    for (const brda of brdas) {
      out.push(brda);
      branchesFound++;
      const taken = brda.split(',')[3];
      if (taken !== '-' && Number(taken) > 0) branchesHit++;
    }
  }
  out.push(`BRF:${branchesFound}`, `BRH:${branchesHit}`);
  let found = 0;
  let hit = 0;
  for (const [n, hits] of [...rec.lines].sort((a, b) => a[0] - b[0])) {
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
