// Checks the line coverage of Vitest's report (coverage/lcov.info) and the
// child-process report (coverage/child/lcov.info, see merge-child-coverage.ts)
// together, the way Codecov merges them. A line counts as covered if either
// report has a hit for it. Fails below the project target in codecov.yml, so
// a drop fails CI even when Codecov doesn't report.
//
// Usage: bun test/setup/check-coverage.ts [coverage-dir]
import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';

const DIR = process.argv[2] ?? 'coverage';
const REPORTS = [
  path.join(DIR, 'lcov.info'),
  path.join(DIR, 'child', 'lcov.info'),
];
const MAX_LISTED = 50;

interface Codecov {
  coverage?: { status?: { project?: { default?: { target?: unknown } } } };
}

function minimum(): number {
  const config = YAML.parse(fs.readFileSync('codecov.yml', 'utf8')) as Codecov;
  const target = config.coverage?.status?.project?.default?.target;
  const value = parseFloat(String(target));
  if (!/^\d+(\.\d+)?%?$/.test(String(target)) || Number.isNaN(value)) {
    throw new Error(
      `codecov.yml: coverage.status.project.default.target is not a percentage: ${String(target)}`,
    );
  }
  return value;
}

// file -> line -> covered
const lines = new Map<string, Map<number, boolean>>();
for (const report of REPORTS) {
  let rec = new Map<number, boolean>();
  for (const line of fs.readFileSync(report, 'utf8').split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      const file = path.relative(process.cwd(), path.resolve(line.slice(3)));
      rec = lines.get(file) ?? new Map<number, boolean>();
      lines.set(file, rec);
    } else if (line.startsWith('DA:')) {
      const [n, hits] = line.slice(3).split(',').map(Number);
      rec.set(n, rec.get(n) === true || hits > 0);
    }
  }
}

let found = 0;
let hit = 0;
const missed: string[] = [];
for (const [file, rec] of [...lines].sort((a, b) => a[0].localeCompare(b[0]))) {
  for (const [n, covered] of [...rec].sort((a, b) => a[0] - b[0])) {
    found++;
    if (covered) hit++;
    else missed.push(`${file}:${n}`);
  }
}

const percent = found === 0 ? 0 : (hit / found) * 100;
const min = minimum();
console.log(
  `Combined line coverage: ${percent.toFixed(2)}% (${hit}/${found}), minimum ${min}%`,
);
if (percent < min) {
  console.error(`Coverage is below ${min}%. Uncovered lines:`);
  for (const entry of missed.slice(0, MAX_LISTED)) console.error(`  ${entry}`);
  if (missed.length > MAX_LISTED) {
    console.error(`  ... and ${missed.length - MAX_LISTED} more`);
  }
  process.exit(1);
}
