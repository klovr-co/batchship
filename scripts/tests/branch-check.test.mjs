import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPr } from '../branch-check.mjs';
import { DEFAULTS } from '../config.mjs';

const pr = (o) => checkPr({ headRef: 'ship/a', baseRef: 'main', headRepo: 'o/r', baseRepo: 'o/r', config: DEFAULTS, ...o });
test('ship/ and hotfix/ heads pass', () => { assert.equal(pr({}), null); assert.equal(pr({ headRef: 'hotfix/b' }), null); });
test('feature head into main is flagged', () => assert.match(pr({ headRef: 'feature/x' }), /must come from/));
test('fork head is flagged even if named ship/', () => assert.match(pr({ headRepo: 'f/r' }), /fork/));
test('PR into another base is ignored', () => assert.equal(pr({ headRef: 'feature/x', baseRef: 'ship/a' }), null));
