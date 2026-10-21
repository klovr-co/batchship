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

import { parseInput, formatOutput } from '../batch-guard.mjs';
test('parses Claude Code input', () =>
  assert.deepEqual(parseInput({ tool_input: { command: 'gh pr create' }, cwd: '/r' }), { agent: 'claude', command: 'gh pr create', cwd: '/r' }));
test('parses agy input', () =>
  assert.deepEqual(parseInput({ toolCall: { name: 'run_command', args: { CommandLine: 'git push origin main', Cwd: '/r' } } }), { agent: 'agy', command: 'git push origin main', cwd: '/r' }));
test('agy output: deny in block mode, allow with warning otherwise', () => {
  assert.equal(formatOutput('agy', 'm', true).decision, 'deny');
  assert.equal(formatOutput('agy', 'm', false).decision, 'allow');
});

const m = { ...DEFAULTS, protectedBranch: 'staging', manualBranches: ['main'] };
test('manual: batch PR to staging with marker is allowed', () => assert.deepEqual(run('gh pr create --base staging', { config: m }), []));
test('manual: PR without --base is flagged', () => assert.equal(run('gh pr create', { config: m }).length, 1));
test('manual: any PR to main is flagged, even from staging or hotfix', () => {
  assert.equal(run('gh pr create --base main', { config: m, branch: 'staging' }).length, 1);
  assert.equal(run('gh pr create --base main', { config: m, branch: 'hotfix/x' }).length, 1);
});
test('manual: push to staging and main both flagged', () => {
  assert.equal(run('git push origin staging', { config: m }).length, 1);
  assert.match(run('git push origin main', { config: m })[0], /manually/);
});

test('env-prefixed push to main is still caught', () => assert.equal(run('FOO=1 git push origin main').length, 1));
test('agent using BATCHSHIP_ALLOW or --no-verify is flagged', () => {
  assert.ok(run('BATCHSHIP_ALLOW=1 git push origin main').some((m) => /bypass/.test(m)));
  assert.ok(run('git push --no-verify origin ship/a').some((m) => /bypass/.test(m)));
});
