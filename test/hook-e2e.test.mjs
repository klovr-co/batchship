// The gate as tug init installs it (.agents/tug/ + .githooks/pre-push), driven by a real `git push` to a bare repo
// that lives inside the test's temp dir (no real remote).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { planInit } from '../lib/init.mjs';
import { assertInTmp, commit, memReader, removeRepo, tempRepo, testGit } from './helpers.mjs';

const repos = [];
after(() => repos.forEach(removeRepo));

test('git push HEAD:branch runs the installed gate: a line-ending flip is rejected, a clean change goes through', () => {
  const dir = tempRepo({ 'a.txt': 'one\ntwo\n' });
  repos.push(dir);
  const bare = assertInTmp(dir) + '-origin.git';
  mkdirSync(bare);
  repos.push(assertInTmp(bare));
  testGit(bare, ['init', '-q', '--bare']);
  testGit(dir, ['remote', 'add', 'origin', bare]);
  testGit(dir, ['push', '-q', 'origin', 'main']);
  testGit(dir, ['fetch', '-q', 'origin']);

  const plan = planInit({ reader: memReader({}), defaultBranch: 'main', existingLabels: [] });
  for (const f of plan.files.filter(f => f.path.startsWith('.agents/') || f.path.startsWith('.githooks/'))) {
    const path = join(dir, f.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.content);
    if (f.mode) chmodSync(path, f.mode);
  }
  testGit(dir, ['config', 'core.hooksPath', '.githooks']);
  commit(dir, {}, 'add tug');
  testGit(dir, ['push', '-q', 'origin', 'HEAD:refs/heads/kit']);

  commit(dir, { 'a.txt': 'one\r\ntwo\r\nthree\r\n' }, 'flip');
  assert.throws(() => testGit(dir, ['push', '-q', 'origin', 'HEAD:fix']), err => /Line endings unchanged/.test(String(err.stderr)) && /a\.txt: lf -> crlf/.test(String(err.stderr)));
  testGit(dir, ['reset', '-q', '--hard', 'HEAD~1']);
  commit(dir, { 'a.txt': 'one\ntwo\nthree\n' }, 'clean');
  testGit(dir, ['push', '-q', 'origin', 'HEAD:fix']);
  assert.equal(testGit(bare, ['rev-parse', 'refs/heads/fix']).trim(), testGit(dir, ['rev-parse', 'HEAD']).trim());
});
