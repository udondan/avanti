import * as fs from 'fs';
import * as path from 'path';
import type { TestProject } from 'vitest/node';

// Tests run the CLI and the privileged worker as child processes, which v8
// coverage of the test workers does not see. When coverage is on, this hands
// a directory to the workers (see child-coverage.ts). The children write their
// raw v8 coverage there, and `bun run coverage:child` turns it into lcov.
const CHILD_COVERAGE_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'coverage',
  'tmp-child',
);

declare module 'vitest' {
  export interface ProvidedContext {
    childCoverageDir: string | undefined;
  }
}

export default function setup(project: TestProject): void {
  if (!project.config.coverage.enabled) {
    project.provide('childCoverageDir', undefined);
    return;
  }
  fs.rmSync(CHILD_COVERAGE_DIR, { recursive: true, force: true });
  fs.mkdirSync(CHILD_COVERAGE_DIR, { recursive: true });
  project.provide('childCoverageDir', CHILD_COVERAGE_DIR);
}
