import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../batch-guard.mjs';
import { DEFAULTS } from '../config.mjs';

const base = { branch: 'ship/a', head: 'abc', marker: 'abc', config: DEFAULTS };
const run = (command, o = {}) => evaluate({ ...base, command, ...o });

test('PR from feature branch is flagged', () => assert.equal(run('gh pr create --base main', { branch: 'feature/x' }).length, 1));
test('PR from ship/ with passing marker is allowed', () => assert.deepEqual(run('gh pr create'), []));
test('PR from ship/ without marker is flagged', () => assert.equal(run('gh pr create', { marker: '' }).length, 1));
test('hotfix PR needs no marker', () => assert.deepEqual(run('gh pr ready', { branch: 'hotfix/b', marker: '' }), []));
test('PR into ship/ branch is free', () => assert.deepEqual(run('gh pr create --base ship/a', { branch: 'feature/x' }), []));
test('push to main is flagged', () => assert.equal(run('git push origin main').length, 1));
test('push HEAD:main is flagged', () => assert.equal(run('git push origin HEAD:main').length, 1));
test('push to ship/ is allowed', () => assert.deepEqual(run('git push -u origin ship/a'), []));
