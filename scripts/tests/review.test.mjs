import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sameHarness, parseReviewer, commandFor, extractVerdict, blocking, SCHEMA } from '../review.mjs';
import { loadConfig } from '../config.mjs';

test('"same" is the innermost harness', () => {
  assert.equal(sameHarness({ CLAUDECODE: '1' }), 'claude');
  assert.equal(sameHarness({ CLAUDECODE: '1', CODEX_SANDBOX: 'seatbelt' }), 'codex');
  assert.equal(sameHarness({ CLAUDECODE: '1', ANTIGRAVITY_AGENT: '1' }), 'agy');
  assert.equal(sameHarness({}), null);
});

test('reviewer specs', () => {
  assert.deepEqual(parseReviewer('codex:gpt-6-sol', {}), { name: 'codex:gpt-6-sol', harness: 'codex', model: 'gpt-6-sol' });
  assert.deepEqual(parseReviewer('same', { CLAUDECODE: '1' }), { name: 'claude', harness: 'claude', model: undefined });
  assert.deepEqual(parseReviewer({ name: 'mine', cmd: 'my-review' }), { name: 'mine', cmd: 'my-review' });
  assert.throws(() => parseReviewer('same', {}), /cannot tell/);
  assert.throws(() => parseReviewer('cursor', {}), /unknown reviewer/);
});

test('every harness runs read-only', () => {
  const c = commandFor({ harness: 'claude', model: 'claude-sonnet-5-5' }, 'P', '/s', '/o');
  assert.ok(c.args.join(' ').includes('--tools Read,Grep,Glob') && c.args.includes('claude-sonnet-5-5'));
  assert.ok(!commandFor({ harness: 'agy' }, 'P', '/s', '/o').args.some((a) => /dangerously/.test(a)));
  assert.deepEqual(commandFor({ harness: 'codex' }, 'P', '/s', '/o').args.slice(0, 3), ['exec', '-s', 'read-only']);
  assert.ok(commandFor({ harness: 'agy' }, 'P', '/s', '/o').args.join(' ').includes('--mode plan'));
});

test('codex output schema is strict (every property required)', () => {
  const strict = (s) => s.type !== 'object' || (s.additionalProperties === false && Object.keys(s.properties).every((k) => s.required.includes(k)) && Object.values(s.properties).every((p) => strict(p.items || p)));
  assert.ok(strict(SCHEMA));
});

test('finds the verdict in wrappers, fences and prose', () => {
  const v = { verdict: 'changes', summary: 's', findings: [{ severity: 'major', file: 'a.ts', line: 3, summary: 'x' }] };
  assert.deepEqual(extractVerdict(JSON.stringify(v)), v);
  assert.deepEqual(extractVerdict(JSON.stringify({ type: 'result', result: 'ok', structured_output: v })), v);
  assert.deepEqual(extractVerdict(JSON.stringify({ result: '```json\n' + JSON.stringify(v) + '\n```' })), v);
  assert.deepEqual(extractVerdict('Done. Here it is: ' + JSON.stringify(v) + ' thanks'), v);
  assert.equal(extractVerdict('no json here'), null);
  assert.equal(extractVerdict('{"verdict":"approve","findings":[}'), null, 'broken JSON at the start does not loop');
});

test('blockers and majors block; minors do not', () =>
  assert.deepEqual(blocking([{ severity: 'minor' }, { severity: 'major' }, { severity: 'blocker' }]).map((f) => f.severity), ['major', 'blocker']));

test('partial review settings keep the defaults', () => {
  const d = mkdtempSync(join(tmpdir(), 'cfg-'));
  writeFileSync(join(d, '.ship.json'), '{"review":{"after":"merge"}}');
  assert.deepEqual([loadConfig(d).review.after, loadConfig(d).review.reviewers, loadConfig(d).review.rounds], ['merge', ['same'], 2]);
});

test('end to end with command reviewers: only new commits, rounds, merges of live pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-'));
  const repo = join(root, 'repo');
  const sh = (c) => execSync(c, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const review = (a = '') => { try { return { code: 0, out: sh(`node ${join(import.meta.dirname, '..', 'review.mjs')} ${a}`) }; } catch (e) { return { code: e.status, out: e.stdout + e.stderr }; } };
  const marker = () => JSON.parse(readFileSync(join(repo, '.git/batchship-review.json'), 'utf8'));
  // The reviewer saves the prompt it got, so the test can see which commits it was shown.
  const reviewer = (verdict) => ({ name: 'r', cmd: `cat > ${join(root, 'prompt.txt')}; echo '${JSON.stringify(verdict)}'` });
  const ok = { verdict: 'approve', summary: 'fine', findings: [{ severity: 'minor', file: 'a', line: null, summary: 'nit' }] };
  const bad = { verdict: 'changes', summary: 'no', findings: [{ severity: 'major', file: 'a', line: 1, summary: 'bug' }] };
  const use = (v, rounds = 2) => writeFileSync(join(repo, '.ship.json'), JSON.stringify({ review: { rounds, reviewers: [reviewer(v)] } }));
  const prompt = () => readFileSync(join(root, 'prompt.txt'), 'utf8');
  execSync(`git init -q --bare origin.git && git init -q -b main repo`, { cwd: root });
  sh(`git config user.email a@b && git config user.name t && git remote add origin ${join(root, 'origin.git')}`);
  writeFileSync(join(repo, 'README'), 'x'); sh('git add -A && git commit -qm base && git push -q -u origin main && git checkout -qb ship/x-20261022');
  use(ok); // only on the batch: the live branch has no .ship.json yet, so the batch's own file applies

  writeFileSync(join(repo, 'one.js'), 'one'); sh('git add -A && git commit -qm "fix one"');
  assert.equal(review().code, 0);
  assert.match(prompt(), /fix one/);
  assert.equal(marker().passed, sh('git rev-parse HEAD').trim());
  assert.match(review().out, /already passed/);

  use(bad); writeFileSync(join(repo, 'two.js'), 'two'); sh('git add -A && git commit -qm "fix two"');
  let r = review();
  assert.equal(r.code, 1); assert.match(r.out, /\[major\] a:1: bug/);
  assert.match(prompt(), /fix two/); assert.doesNotMatch(prompt(), /fix one/, 'only commits since the last pass');
  assert.equal(review().code, 1); assert.equal(marker().failures, 1, 'a re-run on the same HEAD does not use a round');
  sh('git commit -qm "try again" --allow-empty'); review();
  assert.equal(marker().failures, 2);
  sh('git commit -qm "again" --allow-empty');
  assert.match(review().out, /hand the batch to the human/);

  use(ok); sh('git commit -qam "real fix"');
  assert.match(review().out, /hand the batch/, 'still stopped until the human says go on');
  assert.equal(review('--force').code, 0, 'a passing run resets the count');
  assert.equal(marker().failures, 0);

  sh('git checkout -q main && git commit -qm "live moved" --allow-empty && git push -q && git checkout -q ship/x-20261022 && git merge -q --no-edit origin/main');
  r = review();
  assert.equal(r.code, 0); assert.match(r.out, /Nothing new/);

  use({ verdict: 'approve', summary: 'x', findings: [] }); writeFileSync(join(repo, '.ship.json'), JSON.stringify({ review: { reviewers: [{ name: 'broken', cmd: 'exit 3' }] } }));
  sh('git commit -qam three'); assert.equal(review().code, 2);
});

test("the live branch's review policy wins over the batch's own .ship.json", () => {
  const root = mkdtempSync(join(tmpdir(), 'policy-'));
  const repo = join(root, 'repo');
  const sh = (c) => execSync(c, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execSync('git init -q --bare origin.git && git init -q -b main repo', { cwd: root });
  sh(`git config user.email a@b && git config user.name t && git remote add origin ${join(root, 'origin.git')}`);
  const bad = JSON.stringify({ verdict: 'changes', summary: 'no', findings: [{ severity: 'blocker', file: 'a', line: 1, summary: 'bug' }] });
  writeFileSync(join(repo, '.ship.json'), JSON.stringify({ review: { reviewers: [{ name: 'strict', cmd: `cat >/dev/null; echo '${bad}'` }] } }));
  sh('git add -A && git commit -qm base && git push -q -u origin main && git checkout -qb ship/x-20261022');
  writeFileSync(join(repo, '.ship.json'), JSON.stringify({ review: { reviewers: [], after: 'merge' } }));
  sh('git commit -qam "turn review off"');
  let code = 0;
  try { sh(`node ${join(import.meta.dirname, '..', 'review.mjs')}`); } catch (e) { code = e.status; }
  assert.equal(code, 1, 'still reviewed by the live policy');
});

import { pickReviewers } from '../review.mjs';
test('risky changes get riskyReviewers: soloPaths, riskyPaths or size', () => {
  const review = { reviewers: ['same'], riskyReviewers: ['same', 'codex'], riskyPaths: ['convex/schema.ts'], riskyLines: 400 };
  assert.deepEqual(pickReviewers(review, { files: ['app/a.tsx'], lines: 20, soloPaths: ['.github/'] }), { reviewers: ['same'], risky: false, why: '' });
  assert.equal(pickReviewers(review, { files: ['.github/ci.yml'], lines: 2, soloPaths: ['.github/'] }).reviewers.length, 2);
  assert.equal(pickReviewers(review, { files: ['convex/schema.ts'], lines: 2 }).why, 'touches convex/schema.ts');
  assert.equal(pickReviewers(review, { files: ['a.ts'], lines: 401 }).why, '401 changed lines');
  assert.deepEqual(pickReviewers({ ...review, riskyReviewers: null }, { files: ['a.ts'], lines: 999 }).reviewers, ['same']);
  assert.equal(pickReviewers({ ...review, riskyLines: 0 }, { files: ['a.ts'], lines: 9999 }).risky, false);
});
