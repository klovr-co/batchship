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
