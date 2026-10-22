import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../batch-guard.mjs';
import { DEFAULTS } from '../config.mjs';

const base = { branch: 'ship/a', head: 'abc', marker: 'abc', config: DEFAULTS };
const run = (command, o = {}) => evaluate({ ...base, command: command.replace(/^gh pr create(?!.*--draft)/, 'gh pr create --draft'), ...o });

test('PR from feature branch is flagged', () => assert.equal(run('gh pr create --base main', { branch: 'feature/x' }).length, 1));
test('PR from ship/ with passing marker is allowed', () => assert.deepEqual(run('gh pr create'), []));
test('PR from ship/ without marker is flagged', () => assert.equal(run('gh pr create', { marker: '' }).length, 1));
test('hotfix PR needs no marker', () => assert.deepEqual(run('gh pr create', { branch: 'hotfix/b', marker: '' }), []));
test('PR into ship/ branch is free', () => assert.deepEqual(run('gh pr create --base ship/a', { branch: 'feature/x' }), []));
test('push to main is flagged', () => assert.equal(run('git push origin main').length, 1));
test('push HEAD:main is flagged', () => assert.equal(run('git push origin HEAD:main').length, 1));

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
  assert.ok(run('git push --no-verify origin fix/a', { branch: 'fix/a' }).some((m) => /bypass/.test(m)));
});

test('agents may not mark ready or merge, unless the user asked for a hotfix or to ship now', () => {
  assert.match(run('gh pr ready 12')[0], /paid step/);
  assert.match(run('gh pr merge 12 --squash')[0], /human/);
  const hot = { unlocked: new Set(['hotfix']), branch: 'hotfix/checkout-500' };
  assert.deepEqual(run('gh pr ready', hot), []);
  assert.deepEqual(run('gh pr merge 1190 --squash', hot), []);
  assert.deepEqual(evaluate({ ...base, ...hot, command: 'gh pr create --base main --title x' }), [], 'a hotfix may be opened ready');
  assert.match(run('gh pr merge --squash --admin', hot)[0], /--admin/);
  assert.deepEqual(run('gh pr merge 1200 --merge', { unlocked: new Set(['ship-now']) }), []);
});
test('ship.mjs --now and touching the unlock need the user', () => {
  assert.match(run('node .batchship/ship.mjs --now')[0], /ship now/);
  assert.deepEqual(run('node .batchship/ship.mjs --now', { unlocked: new Set(['ship-now']) }), []);
  assert.deepEqual(run('node .batchship/ship.mjs'), []);
  assert.match(run('echo {} > .git/batchship-unlock.json')[0], /Only the user/);
  assert.match(run('echo \'{"prompt":"hotfix"}\' | node scripts/intent.mjs')[0], /Only the user/);
  assert.match(evaluate({ ...base, filePath: '/r/.git/batchship-unlock.json' })[0], /Only the user/);
  assert.match(run('cat > "$(git rev-parse --git-common-dir)/batchship-un"*')[0], /Only the user/);
  assert.ok(run('BATCHSHIP_ALLOW=1 node .batchship/ship.mjs --now', { unlocked: new Set(['ship-now']) }).some((m) => /override/.test(m)));
});
test('batches change only through the scripts; fix branches push freely', () => {
  assert.match(run('git push')[0], /fix branch instead/);
  assert.match(run('git push origin HEAD')[0], /fix branch instead/);
  assert.equal(run('git push origin main').length, 1, 'pushing main from a batch checkout is one problem, not two');
  assert.match(run('git push origin HEAD:ship/day-20261022', { branch: 'fix/x' })[0], /fix branch instead/);
  assert.deepEqual(run('git push -u origin fix/offline-qr', { branch: 'fix/offline-qr' }), []);
  assert.deepEqual(run('git push -u origin hotfix/x', { branch: 'hotfix/x' }), []);
  assert.match(run('git push origin +HEAD:refs/heads/ship/day-20261022', { branch: 'fix/x' })[0], /fix branch instead/);
});
test('fix PRs into a batch need no draft and no marker', () =>
  assert.deepEqual(evaluate({ ...base, branch: 'fix/x', marker: '', command: 'gh pr create --base ship/day-20261022 --title x' }), []));
test('agents may not force a review past the round limit', () => {
  assert.match(run('node .batchship/review.mjs --force')[0], /Only the human/);
  assert.deepEqual(run('node .batchship/review.mjs --focus "auth"'), []);
});
test('non-draft PR create is flagged', () => assert.ok(evaluate({ ...base, command: 'gh pr create --base main' }).some((m) => /draft/.test(m))));

const branches = { '/r': 'main', '/r/src': 'main', '/wt': 'ship/a-20261022', '/wt/src': 'ship/a-20261022' };
const at = (o) => evaluate({ ...base, branchOf: (d) => branches[d] || 'main', ...o });
test('editing a file on the live branch says triage first; in a batch worktree it is fine', () => {
  assert.match(at({ filePath: '/r/src/a.js' })[0], /fix\.mjs start/);
  assert.deepEqual(at({ filePath: '/wt/src/a.js' }), []);
  assert.match(at({ filePath: '/r/src/a.js', config: m, branchOf: () => 'staging' })[0], /staging/);
});
test('commit on live is flagged, following cd and git -C', () => {
  assert.match(at({ command: 'git commit -m x', cwd: '/r' })[0], /fix\.mjs start/);
  assert.deepEqual(at({ command: 'cd /wt && git commit -m x', cwd: '/r' }), []);
  assert.deepEqual(at({ command: 'git -C /wt commit -m x', cwd: '/r' }), []);
  assert.equal(at({ command: 'cd /wt && git commit -m x && cd /r && git commit -m y', cwd: '/r' }).length, 1);
});

import { soloMix } from '../batch-check.mjs';
test('soloPaths must not mix with other changes', () => {
  assert.equal(soloMix(['.github/w.yml', 'a.js'], ['.github/'])[0], '.github/w.yml');
  assert.equal(soloMix(['.github/w.yml'], ['.github/']), null);
  assert.equal(soloMix(['a.js'], []), null);
});
test('cd through variables and subshells: resolved when possible, quiet when not', () => {
  assert.deepEqual(at({ command: 'W=/wt\ncd $W && git commit -m x', cwd: '/r' }), []);
  assert.deepEqual(at({ command: 'for n in a b; do (cd /x/$n && gh pr create --draft --base main); done', cwd: '/r' }), []);
  assert.equal(at({ command: 'W=/r\ncd "$W" && git commit -m x', cwd: '/wt' }).length, 1);
});
test('PR check reads the marker of the worktree the command runs in', () => {
  const o = { headOf: (d) => (d === '/wt' ? 'w1' : 'm1'), markerOf: (d) => (d === '/wt' ? 'w1' : '') };
  assert.deepEqual(at({ command: 'cd /wt && gh pr create --draft --base main', cwd: '/r', ...o }), []);
  assert.match(at({ command: 'cd /wt && gh pr create --draft --base main', cwd: '/r', ...o, markerOf: () => '' })[0], /batch-check/);
});
