import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBatch, ageDays, ymd, batchName, whyNotJoinable } from '../triage.mjs';

const today = new Date(2026, 9, 21, 7, 30); // 07:30 local: still the 21st even where UTC is the 20th
const day = (n) => ymd(new Date(2026, 9, 21 - n));
const b = (name, extra = {}) => ({ ...parseBatch(name), state: 'open', ...extra });

test('parses dated batches only; age is in local days', () => {
  const p = parseBatch(`ship/web-address-${day(0)}-2`);
  assert.equal(p.slug, 'web-address');
  assert.equal(ageDays(p.created, today), 0);
  assert.equal(ageDays(parseBatch(`ship/x-${day(3)}`).created, today), 3);
  assert.equal(parseBatch('ship/setup-batchship'), null);
  assert.equal(ymd(today), '20261021');
});

test('names: slugged, dated, suffixed when taken', () => {
  assert.equal(batchName('Checkout Flow!', today, new Set()), `ship/checkout-flow-${day(0)}`);
  assert.equal(batchName('checkout-flow', today, new Set([`ship/checkout-flow-${day(0)}`])), `ship/checkout-flow-${day(0)}-2`);
});

test('hard limits only: draft, recent, idle, not solo', () => {
  assert.equal(whyNotJoinable(b(`ship/a-${day(7)}`), today), '');
  assert.match(whyNotJoinable(b(`ship/a-${day(8)}`), today), /older than 7/);
  assert.match(whyNotJoinable(b(`ship/a-${day(1)}`), today, 0), /older than 0/);
  assert.match(whyNotJoinable(b(`ship/a-${day(0)}`, { state: 'frozen' }), today), /ready/);
  assert.match(whyNotJoinable(b(`ship/a-${day(0)}`, { state: 'done' }), today), /merged/);
  assert.match(whyNotJoinable(b(`ship/a-${day(0)}`, { busy: true }), today), /mid-edit/);
  assert.match(whyNotJoinable(b(`ship/a-${day(0)}`, { solo: true }), today), /soloPaths/);
});

test('end to end in a real repo: new, list, join, busy refusal, adopt', () => {
  const root = mkdtempSync(join(tmpdir(), 'triage-'));
  const repo = join(root, 'repo');
  const run = (cmd, cwd = repo) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const triage = (a, cwd = repo) => JSON.parse(run(`node ${join(import.meta.dirname, '..', 'triage.mjs')} ${a} --json --no-install`, cwd));
  execSync('git init -q --bare origin.git && git init -q -b main repo', { cwd: root });
  run(`git config user.email a@b && git config user.name t && git remote add origin ${join(root, 'origin.git')}`);
  writeFileSync(join(repo, '.ship.json'), '{"protectedBranch":"main","soloPaths":[".github/"]}');
  run('git add -A && git commit -qm init && git push -q -u origin main');

  const first = triage('new "Checkout flow"');
  assert.equal(first.batch, `ship/checkout-flow-${ymd(new Date())}`);
  assert.ok(existsSync(first.worktree));
  assert.ok(run('git ls-remote origin').includes(`refs/heads/${first.batch}`));
  assert.equal(run('git branch --show-current'), 'main', 'your own checkout is untouched');

  writeFileSync(join(first.worktree, 'pay.js'), 'x');
  run('git add -A && git commit -qm "fix pay button" && git push -q', first.worktree);
  const [listed] = triage('list');
  assert.deepEqual([listed.commits, listed.files, listed.busy], [['fix pay button'], ['pay.js'], false]);

  assert.equal(triage(`join ${first.batch}`).worktree, first.worktree, 'join reuses the worktree');
  writeFileSync(join(first.worktree, 'wip.js'), 'x');
  assert.throws(() => run(`node ${join(import.meta.dirname, '..', 'triage.mjs')} join ${first.batch}`), /mid-edit/);

  run('git worktree add -q ../t3-wt -b t3/abc origin/main');
  const adopted = triage('adopt onboarding', join(root, 't3-wt'));
  assert.equal(adopted.batch, `ship/onboarding-${ymd(new Date())}`);
  assert.equal(run('git branch --show-current', join(root, 't3-wt')), adopted.batch);
  assert.throws(() => run(`node ${join(import.meta.dirname, '..', 'triage.mjs')} adopt x`), /use triage.mjs new/);
});
