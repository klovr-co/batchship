import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkGenerated } from '../lib/checks/generated-current.mjs';
import { parseConfig } from '../lib/config.mjs';
import { parsePushLines, runPrePush } from '../lib/pre-push.mjs';
import { commit, removeRepo, tempRepo, testGit } from './helpers.mjs';

const Z = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('parsePushLines checks every branch push, including HEAD:branch and sha:ref', () => {
  const lines = [
    `HEAD ${A} refs/heads/fix-1 ${Z}`, // git push origin HEAD:fix-1
    `refs/heads/fix-2 ${B} refs/heads/fix-2 ${A}`,
    `${A} ${A} refs/heads/dup ${Z}`, // same sha twice: once
  ].join('\n');
  assert.deepEqual(parsePushLines(lines), [
    { sha: A, label: 'fix-1', localRef: 'HEAD' },
    { sha: B, label: 'fix-2', localRef: 'refs/heads/fix-2' },
  ]);
});

test('parsePushLines skips only deletes and tags', () => {
  const lines = [`(delete) ${Z} refs/heads/old ${A}`, `refs/tags/v1 ${A} refs/tags/v1 ${Z}`, `HEAD ${A} refs/tags/v2 ${Z}`, ''].join('\n');
  assert.deepEqual(parsePushLines(lines), []);
  assert.deepEqual(parsePushLines(`HEAD ${B} refs/notes/x ${Z}`).length, 1, 'anything not a tag or delete is checked');
});

const repos = [];
after(() => repos.forEach(removeRepo));
const quiet = { log: () => {}, error: () => {} };

test('gate in a temp repo: a `HEAD:branch` push of a line-ending flip fails; tags and deletes pass', () => {
  const dir = tempRepo({ 'a.txt': 'one\ntwo\n' });
  repos.push(dir);
  const sha = commit(dir, { 'a.txt': 'one\r\ntwo\r\n' });
  const config = parseConfig(null);
  const head = runPrePush({ root: dir, hookInput: `HEAD ${sha} refs/heads/fix ${Z}\n`, config, ...quiet });
  assert.equal(head.ok, false);
  assert.equal(head.failures[0].name, 'Line endings unchanged');
  assert.equal(runPrePush({ root: dir, hookInput: null, config, ...quiet }).ok, false, 'no stdin: checks HEAD');
  assert.equal(runPrePush({ root: dir, hookInput: `refs/tags/v1 ${sha} refs/tags/v1 ${Z}\n`, config, ...quiet }).ok, true);
  assert.equal(runPrePush({ root: dir, hookInput: `(delete) ${Z} refs/heads/fix ${sha}\n`, config, ...quiet }).ok, true);
});

test('gate in a temp repo: checkCommand runs with the hook stdin; failure fails the push', () => {
  const dir = tempRepo({ 'a.txt': 'one\n' });
  repos.push(dir);
  const sha = commit(dir, { 'a.txt': 'one\ntwo\n' });
  const input = `HEAD ${sha} refs/heads/fix ${Z}\n`;
  const pass = runPrePush({ root: dir, hookInput: input, config: parseConfig(`checkCommand: "grep -q refs/heads/fix && test \\"$SHIPLANE_SHIP_BRANCH\\" = main"\n`), ...quiet });
  assert.equal(pass.ok, true, JSON.stringify(pass.failures));
  const fail = runPrePush({ root: dir, hookInput: input, config: parseConfig('checkCommand: "exit 3"\n'), ...quiet });
  assert.equal(fail.ok, false);
  assert.match(fail.failures[0].name, /exit 3/);
});

test('gate in a temp repo: a failing check in a worktree with no node_modules says to run the install command', () => {
  const dir = tempRepo({ 'package.json': '{"packageManager":"bun@1.3.10"}\n', '.bun-version': '1.3.10\n', 'bun.lock': '{}\n' });
  repos.push(dir);
  commit(dir, { 'a.txt': 'x\n' });
  const out = runPrePush({ root: dir, hookInput: null, config: parseConfig('checkCommand: "exit 1"\n'), ...quiet });
  assert.equal(out.ok, false);
  assert.match(out.failures[0].message, /no node_modules .*run `bunx bun@\$\(cat \.bun-version\) install --frozen-lockfile`/);
});

test('gate in a temp repo: already on origin/main means nothing to check', () => {
  const dir = tempRepo();
  repos.push(dir);
  const head = testGit(dir, ['rev-parse', 'HEAD']).trim();
  assert.equal(runPrePush({ root: dir, hookInput: `HEAD ${head} refs/heads/x ${Z}\n`, config: parseConfig('checkCommand: "exit 1"\n'), ...quiet }).ok, true);
});

test('generated-current in a temp repo: stale output fails, current output passes, a dirty tree is fine', () => {
  const dir = tempRepo({ 'gen.sh': 'printf "v2\\n" > out.txt\n', 'out.txt': 'v1\n' });
  repos.push(dir);
  writeFileSync(join(dir, 'unrelated.txt'), 'dirty\n');
  const stale = checkGenerated({ cwd: dir, run: 'sh gen.sh' });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.changed, ['out.txt']);
  commit(dir, {});
  assert.equal(checkGenerated({ cwd: dir, run: 'sh gen.sh' }).ok, true);
  const broken = checkGenerated({ cwd: dir, run: 'exit 4' });
  assert.equal(broken.ok, false);
  assert.match(broken.message, /exit 4/);
});

test('the helper refuses paths outside the temp dir', async () => {
  const { assertInTmp } = await import('./helpers.mjs');
  assert.throws(() => assertInTmp(''), /empty/);
  assert.throws(() => assertInTmp(undefined), /empty/);
  assert.throws(() => assertInTmp(process.cwd()), /not inside/);
});
