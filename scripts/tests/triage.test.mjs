import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, parseBatch, ageDays, ymd } from '../triage.mjs';

const today = new Date(2026, 9, 21, 7, 30); // 07:30 local: still the 21st even where UTC is the 20th
const day = (n) => ymd(new Date(2026, 9, 21 - n));
const b = (name, state = 'open') => ({ ...parseBatch(name), state });

test('parses dated batches only; age is in local days', () => {
  const p = parseBatch(`ship/web-address-${day(0)}-2`);
  assert.equal(p.area, 'web-address');
  assert.equal(ageDays(p.created, today), 0);
  assert.equal(ageDays(parseBatch(`ship/x-${day(3)}`).created, today), 3);
  assert.equal(parseBatch('ship/setup-batchship'), null);
  assert.equal(ymd(today), '20261021');
});

test('joins the newest same-area draft batch within the week', () => {
  const d = decide({ batches: [b(`ship/billing-${day(5)}`), b(`ship/billing-${day(2)}`)], area: 'billing', today });
  assert.deepEqual([d.action, d.batch], ['join', `ship/billing-${day(2)}`]);
});

test('older than the limit: not joined, listed stale, new batch', () => {
  const d = decide({ batches: [b(`ship/billing-${day(11)}`)], area: 'billing', today });
  assert.deepEqual([d.action, d.batch, d.stale], ['new', `ship/billing-${day(0)}`, [`ship/billing-${day(11)}`]]);
});

test('frozen or done batches are not joined; same-day name gets a suffix', () => {
  const d = decide({ batches: [b(`ship/billing-${day(0)}`, 'frozen'), b(`ship/billing-${day(1)}`, 'done')], area: 'billing', today });
  assert.deepEqual([d.action, d.batch], ['new', `ship/billing-${day(0)}-2`]);
});

test('other areas are separate; ci never joins; maxAgeDays 0 means same day only', () => {
  assert.equal(decide({ batches: [b(`ship/web-${day(0)}`)], area: 'billing', today }).action, 'new');
  assert.equal(decide({ batches: [b(`ship/ci-${day(0)}`)], area: 'ci', today }).batch, `ship/ci-${day(0)}-2`);
  assert.equal(decide({ batches: [b(`ship/billing-${day(1)}`)], area: 'billing', today, maxAgeDays: 0 }).action, 'new');
});

test('end to end in a real repo: new batch with pushed branch and worktree, then join reuses it', () => {
  const root = mkdtempSync(join(tmpdir(), 'triage-'));
  const repo = join(root, 'repo');
  const run = (cmd, cwd = repo) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const triage = (a) => JSON.parse(run(`node ${join(import.meta.dirname, '..', 'triage.mjs')} ${a} --json`));
  execSync('git init -q --bare origin.git && git init -q -b main repo', { cwd: root });
  run(`git config user.email a@b && git config user.name t && git remote add origin ${join(root, 'origin.git')}`);
  writeFileSync(join(repo, '.ship.json'), '{"protectedBranch":"main"}');
  run('git add -A && git commit -qm init && git push -q -u origin main');

  const first = triage('--area billing --apply');
  assert.equal(first.action, 'new');
  assert.ok(existsSync(first.worktree));
  assert.ok(run('git ls-remote origin').includes(`refs/heads/${first.batch}`));
  assert.equal(run('git branch --show-current'), 'main', 'your own checkout is untouched');

  const second = triage('--area billing --apply');
  assert.deepEqual([second.action, second.batch, second.worktree], ['join', first.batch, first.worktree]);
});
