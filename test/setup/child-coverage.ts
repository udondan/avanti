import { inject } from 'vitest';

// Set at runtime, so only processes spawned from here on write coverage, not
// the test worker itself. Child processes inherit process.env.
const dir = inject('childCoverageDir');
if (dir) process.env.NODE_V8_COVERAGE = dir;
