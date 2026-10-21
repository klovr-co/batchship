import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPr } from '../branch-check.mjs';
import { DEFAULTS } from '../config.mjs';

const pr = (o) => checkPr({ headRef: 'ship/a', baseRef: 'main', headRepo: 'o/r', baseRepo: 'o/r', config: DEFAULTS, ...o });
test('ship/ and hotfix/ heads pass', () => { assert.equal(pr({}), null); assert.equal(pr({ headRef: 'hotfix/b' }), null); });
test('feature head into main is flagged', () => assert.match(pr({ headRef: 'feature/x' }), /must come from/));
test('fork head is flagged even if named ship/', () => assert.match(pr({ headRepo: 'f/r' }), /fork/));
test('PR into another base is ignored', () => assert.equal(pr({ headRef: 'feature/x', baseRef: 'ship/a' }), null));

const m = { ...DEFAULTS, protectedBranch: 'staging', manualBranches: ['main'] };
test('manual: ship/ into staging ok, feature into staging flagged', () => {
  assert.equal(pr({ baseRef: 'staging', config: m }), null);
  assert.match(pr({ baseRef: 'staging', headRef: 'feature/x', config: m }), /must come from/);
});
test('manual: PRs into main are not checked in CI', () => assert.equal(pr({ baseRef: 'main', headRef: 'staging', config: m }), null));
