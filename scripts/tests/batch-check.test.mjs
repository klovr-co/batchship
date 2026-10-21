import test from 'node:test';
import assert from 'node:assert/strict';
import { selectChecks } from '../batch-check.mjs';

const checks = [
  { name: 'lint', cmd: 'l', quick: true, paths: ['web/'] },
  { name: 'api', cmd: 'a', paths: ['backend/'] },
  { name: 'all', cmd: 'x' },
];
test('selects by changed path, always-on checks included', () =>
  assert.deepEqual(selectChecks(['web/a.ts'], checks).map((c) => c.name), ['lint', 'all']));
test('quick keeps only quick checks', () =>
  assert.deepEqual(selectChecks(['web/a.ts', 'backend/b.ts'], checks, { quick: true }).map((c) => c.name), ['lint']));
