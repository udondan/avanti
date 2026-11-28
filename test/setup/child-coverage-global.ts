import * as fs from 'fs';
import * as path from 'path';
import type { TestProject } from 'vitest/node';

// Tests run the CLI and the privileged worker as child processes, which v8
// coverage of the test workers does not see. When coverage is on, this hands
// a directory to the workers (see child-coverage.ts). The children write their
// raw v8 coverage there (<reportsDirectory>/tmp-child), and
// `bun run coverage:child` turns it into lcov.

declare module 'vitest' {
  export interface ProvidedContext {
    childCoverageDir: string | undefined;
  }
}

export default function setup(project: TestProject): void {
  const { enabled, reportsDirectory } = project.config.coverage;
  if (!enabled) {
    project.provide('childCoverageDir', undefined);
    return;
  }
  const dir = path.resolve(reportsDirectory, 'tmp-child');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  project.provide('childCoverageDir', dir);
}
