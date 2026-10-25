import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intents } from '../lib.mjs';
import { ymd } from '../triage.mjs';

test('quoted text is not a request: code fences and > quotes', () => {
  assert.deepEqual(intents('what happens here?\n```\nfix: a\nthen ship when done\n```\nwill it make worktrees?'), []);
  assert.deepEqual(intents('> then ship when done\nwhat does that do'), []);
  assert.deepEqual(intents('```\nexample\n```\nfix the label, then ship when done'), ['ship'], 'the user\'s own line still counts');
});

test('batchPer session: each thread fills and ships its own batch', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-'));
  const repo = join(root, 'repo');
  const sh = (cmd, cwd = repo) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const as = (session, name, a, cwd = repo) => sh(`CLAUDE_CODE_SESSION_ID=${session} CODEX_THREAD_ID= node ${join(import.meta.dirname, '..', name)} ${a}`, cwd);
  execSync('git init -q --bare origin.git && git init -q -b main repo', { cwd: root });
  sh(`git config user.email a@b && git config user.name t && git remote add origin ${join(root, 'origin.git')}`);
  const ok = JSON.stringify({ verdict: 'approve', summary: 'fine', findings: [] }).replaceAll('"', '\\"');
  writeFileSync(join(repo, '.ship.json'), JSON.stringify({ protectedBranch: 'main', batchPer: 'session', checks: [{ name: 'ok', cmd: 'true' }],
    review: { reviewers: [{ name: 'r', cmd: `cat >/dev/null; echo "${ok}"` }] } }));
  sh('git add -A && git commit -qm init && git push -q -u origin main');
  const d = ymd(new Date());
  const fix = (session, name, file) => {
    const out = as(session, 'fix.mjs', `start "${name}" --no-install`);
    const wt = out.match(/work in: (.+)/)[1];
    writeFileSync(join(wt, file), file);
    sh(`git add -A && git commit -qm "${name}"`, wt);
    as(session, 'fix.mjs', 'done', wt);
    return out.match(/-> (\S+)/)[1];
  };
  const a1 = fix('thread-aaaa', 'Cart total', 'cart.js');
  const b1 = fix('thread-bbbb', 'Label plural', 'label.js');
  const a2 = fix('thread-aaaa', 'Welcome copy', 'welcome.js');
  assert.equal(a1, `ship/cart-total-${d}`, 'named after the thread\'s first fix');
  assert.equal(a2, a1, 'the same thread keeps its batch');
  assert.equal(b1, `ship/label-plural-${d}`, 'another thread gets its own');
  assert.match(sh(`git log --format=%s origin/${a1}`), /batch: one batch per thread \(session thread-a/);
  assert.match(as('thread-aaaa', 'ship.mjs', ''), new RegExp(`SHIPPED ${a1.replace('/', '\\/')} locally`), 'a thread ships its own batch');
  sh('git fetch -q origin');
  assert.ok(!sh(`git log --format=%s origin/${a1}`).includes('Label plural'), 'thread B\'s fix is not in thread A\'s batch');
});

test('unclosed fences and > quotes never unlock (the user can say it again)', () => {
  assert.deepEqual(intents('look at this:\n```\nthen ship when done'), []);
  assert.deepEqual(intents('```\nexample\nhotfix: login 500'), []);
  assert.deepEqual(intents('> hotfix: login 500\nshould we?'), []);
  assert.deepEqual(intents('> earlier you said this\nhotfix: login 500'), ['hotfix'], 'a real line after a quote still counts');
});

import { evaluate } from '../batch-guard.mjs';
import { DEFAULTS } from '../config.mjs';
test('-R in a quoted argument does not skip the guard', () => {
  const base = { branch: 'ship/a', head: 'a', marker: 'a', config: DEFAULTS, mergify: true, repo: 'klovr-co/aldrent' };
  assert.notDeepEqual(evaluate({ ...base, command: 'gh pr merge 5 --body "-R a/b"' }), []);
  assert.notDeepEqual(evaluate({ ...base, command: "gh pr ready 5 --body '--repo=x/y'" }), []);
  assert.deepEqual(evaluate({ ...base, command: 'gh pr merge 5 --repo=klovr-co/batchship' }), []);
});

test('batchPer session: a thread with no batch cannot ship another thread\'s', () => {
  const root = mkdtempSync(join(tmpdir(), 'session-own-'));
  const repo = join(root, 'repo');
  const sh = (cmd, cwd = repo) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const as = (session, name, a, cwd = repo) => sh(`CLAUDE_CODE_SESSION_ID=${session} CODEX_THREAD_ID= node ${join(import.meta.dirname, '..', name)} ${a}`, cwd);
  execSync('git init -q --bare origin.git && git init -q -b main repo', { cwd: root });
  sh(`git config user.email a@b && git config user.name t && git remote add origin ${join(root, 'origin.git')}`);
  const ok = JSON.stringify({ verdict: 'approve', summary: 'fine', findings: [] }).replaceAll('"', '\\"');
  writeFileSync(join(repo, '.ship.json'), JSON.stringify({ protectedBranch: 'main', batchPer: 'session', checks: [{ name: 'ok', cmd: 'true' }],
    review: { reviewers: [{ name: 'r', cmd: `cat >/dev/null; echo "${ok}"` }] } }));
  sh('git add -A && git commit -qm init && git push -q -u origin main');
  const out = as('thread-aaaa', 'fix.mjs', 'start "Cart total" --no-install');
  const wt = out.match(/work in: (.+)/)[1];
  writeFileSync(join(wt, 'cart.js'), 'c');
  sh('git add -A && git commit -qm "Cart total"', wt);
  as('thread-aaaa', 'fix.mjs', 'done', wt);
  let err = '';
  try { as('thread-cccc', 'ship.mjs', ''); } catch (e) { err = String(e.stderr); }
  assert.match(err, /no batch of its own/);
  const other = as('thread-dddd', 'fix.mjs', `start "Label" --batch ship/cart-total-${ymd(new Date())} --no-install`);
  assert.match(other, /-> ship\/cart-total-/, 'an explicit --batch joins it');
  assert.match(as('thread-dddd', 'ship.mjs', ''), /SHIPPED ship\/cart-total-/, '--batch made it this session\'s batch too');
});
