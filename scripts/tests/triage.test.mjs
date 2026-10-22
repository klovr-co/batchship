import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBatch, ageDays, ymd, batchName, whyNotJoinable } from '../triage.mjs';
import { intents, grant, unlocked } from '../lib.mjs';
import { prText } from '../ship.mjs';

const today = new Date(2026, 9, 21, 7, 30); // 07:30 local: still the 21st even where UTC is the 20th
const day = (n) => ymd(new Date(2026, 9, 21 - n));
const b = (name, extra = {}) => ({ ...parseBatch(name), state: 'open', files: [], ...extra });

test('parses dated batches only; age is in local days', () => {
  assert.equal(parseBatch(`ship/day-${day(0)}-2`).slug, 'day');
  assert.equal(ageDays(parseBatch(`ship/x-${day(3)}`).created, today), 3);
  assert.equal(parseBatch('ship/setup-batchship'), null);
  assert.equal(ymd(today), '20261021');
});

test('names: slugged, dated, suffixed when taken', () => {
  assert.equal(batchName('CI Runners!', today, new Set()), `ship/ci-runners-${day(0)}`);
  assert.equal(batchName('day', today, new Set([`ship/day-${day(0)}`])), `ship/day-${day(0)}-2`);
});

test('joining: only today, not shipping, not full, not solo', () => {
  const cfg = { batchMaxAgeDays: 0, batchMaxFiles: 3 };
  assert.equal(whyNotJoinable(b(`ship/day-${day(0)}`), today, cfg), '');
  assert.match(whyNotJoinable(b(`ship/day-${day(1)}`), today, cfg), /earlier day/);
  assert.equal(whyNotJoinable(b(`ship/day-${day(1)}`), today, { batchMaxAgeDays: 7 }), '');
  assert.match(whyNotJoinable(b(`ship/day-${day(0)}`, { state: 'closing' }), today, cfg), /shipping/);
  assert.match(whyNotJoinable(b(`ship/day-${day(0)}`, { state: 'frozen' }), today, cfg), /ready/);
  assert.match(whyNotJoinable(b(`ship/day-${day(0)}`, { files: ['a', 'b', 'c'] }), today, cfg), /full/);
  assert.equal(whyNotJoinable(b(`ship/day-${day(0)}`, { files: ['a', 'b', 'pnpm-lock.yaml'] }), today, cfg), '', 'lockfiles do not count');
  assert.match(whyNotJoinable(b(`ship/day-${day(0)}`, { solo: true }), today, cfg), /soloPaths/);
});

test('only the user\'s own words unlock hotfix and ship', () => {
  assert.deepEqual(intents('hotfix: checkout returns 500'), ['hotfix']);
  assert.deepEqual(intents('the login loop is back\nhotfix it please'), ['hotfix']);
  assert.deepEqual(intents('fix the cart total, the welcome copy and the label, then ship when done'), ['ship']);
  assert.deepEqual(intents('1. cart total\n2. label plural\nship it once they are all done'), ['ship']);
  assert.deepEqual(intents('ship when everything is finished'), ['ship']);
  assert.deepEqual(intents("1. cart total\n2. label plural\nship it once they're all done"), ['ship']);
  assert.deepEqual(intents('do these and ship after this'), ['ship']);
  assert.deepEqual(intents('ship now'), ['ship']);
  assert.deepEqual(intents('/ship-batch ship --merge'), ['ship']);
  assert.deepEqual(intents('if i wanna do hotfix i still can just do it'), [], 'talking about hotfixes');
  assert.deepEqual(intents('if I say ship when done, will it wait?'), [], 'a question');
  assert.deepEqual(intents('so if we say ship when done it ships the batch'), [], 'after "if"');
  assert.deepEqual(intents('the "then ship" step should be clearer'), [], 'quoted');
  assert.deepEqual(intents('hotfix flow: how does it work?'), []);
  assert.deepEqual(intents('fix the cart total'), []);
  const repo = mkdtempSync(join(tmpdir(), 'unlock-'));
  execSync('git init -q', { cwd: repo });
  grant(repo, 's1', ['hotfix'], 1000);
  assert.deepEqual([...unlocked(repo, 's1', 2000)], ['hotfix']);
  assert.deepEqual([...unlocked(repo, 's2', 2000)], [], 'another session is not unlocked');
  assert.deepEqual([...unlocked(repo, 's1', 1000 + 3 * 3600_000)], [], 'expires');
});

test('batch PR lists every fix with its PR and says how to merge', () => {
  const { title, body } = prText({ batch: `ship/day-${day(0)}`, live: 'main', subjects: ['batch: x', 'Offline QR pass (#1201)', 'Calmer polling (#1202)', 'Load test'], reason: '', review: [{ name: 'claude', ok: true, verdict: 'approve', summary: 'fine', findings: [] }] });
  assert.equal(title, 'Batch 2026-10-21: Offline QR pass, Calmer polling, Load test');
  assert.match(body, /- #1201 Offline QR pass\n- #1202 Calmer polling\n- Load test/);
  assert.match(body, /merge commit/);
  assert.match(body, /claude\*\*: approve/);
});

test('end to end without GitHub: today, fix start/done (reused worker), eject, ship, hotfix', () => {
  const root = mkdtempSync(join(tmpdir(), 'flow-'));
  const repo = join(root, 'repo');
  const sh = (cmd, cwd = repo) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const s = (name, a, cwd = repo) => sh(`node ${join(import.meta.dirname, '..', name)} ${a}`, cwd);
  const fails = (name, a, cwd = repo) => { try { s(name, a, cwd); return ''; } catch (e) { return e.stderr + e.stdout; } };
  execSync('git init -q --bare origin.git && git init -q -b main repo', { cwd: root });
  sh(`git config user.email a@b && git config user.name t && git remote add origin ${join(root, 'origin.git')}`);
  const ok = JSON.stringify({ verdict: 'approve', summary: 'fine', findings: [] }).replaceAll('"', '\\"');
  writeFileSync(join(repo, '.ship.json'), JSON.stringify({ protectedBranch: 'main', checks: [{ name: 'ok', cmd: 'true' }],
    review: { reviewers: [{ name: 'r', cmd: `cat >/dev/null; echo "${ok}"` }] } }));
  sh('git add -A && git commit -qm init && git push -q -u origin main');
  const batch = `ship/day-${ymd(new Date())}`;

  assert.match(s('triage.mjs', 'today'), new RegExp(`${batch} \\(created\\)`));
  assert.match(fails('triage.mjs', 'new ci-runners'), /needs --reason/);

  const one = s('fix.mjs', 'start "Offline QR" --no-install');
  const worker = one.match(/work in: (.+)/)[1];
  assert.match(one, new RegExp(`FIX fix/offline-qr -> ${batch}`));
  assert.equal(sh('git branch --show-current'), 'main', 'your own checkout is untouched');
  writeFileSync(join(worker, 'qr.js'), 'qr');
  sh('git add -A && git commit -qm "Offline QR pass"', worker);
  assert.match(s('fix.mjs', 'done', worker), new RegExp(`MERGED into ${batch}`));
  assert.equal(sh(`git log --format=%s -1 origin/${batch}`), 'Offline QR pass');

  const two = s('fix.mjs', 'start polling --no-install', worker);
  assert.match(two, /reused worker/);
  assert.equal(two.match(/work in: (.+)/)[1], worker);
  writeFileSync(join(worker, 'poll.js'), 'poll');
  sh('git add -A && git commit -qm "Calmer polling"', worker);
  s('fix.mjs', 'done', worker);
  assert.deepEqual(sh(`git log --first-parent --no-merges --format=%s origin/main..origin/${batch}`).split('\n'), ['Calmer polling', 'Offline QR pass']);

  assert.match(s('fix.mjs', 'eject polling --reason "breaks the guest page"'), /EJECTED "Calmer polling"/);
  sh(`git fetch -q origin`);
  assert.ok(!existsSync(join(repo, 'poll.js')));
  assert.equal(sh(`git show origin/${batch}:poll.js 2>/dev/null || echo gone`), 'gone');

  sh('git commit -qm "live moved" --allow-empty && git push -q');
  assert.match(s('ship.mjs', ''), /SHIPPED .* locally/);
  sh('git fetch -q origin');
  assert.ok(sh(`git log --format=%s origin/${batch}`).includes('live moved'), 'ship merged the live branch in');

  const hot = s('triage.mjs', 'hotfix "Checkout 500" --no-install');
  assert.match(hot, /HOTFIX hotfix\/checkout-500/);
  assert.equal(sh('git branch --show-current', hot.match(/work in: (.+)/)[1]), 'hotfix/checkout-500');
  assert.match(fails('ship.mjs', '--merge'), /needs the user to ask/);
  grant(repo, 'other-session', ['ship']);
  assert.match(fails('ship.mjs', '--merge'), /needs the user to ask/, 'a grant from another session does not count');
});
