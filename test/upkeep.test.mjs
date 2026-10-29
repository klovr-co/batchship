import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { detectPackageManager, installCommand } from '../lib/pm.mjs';
import { parseRegistry, register, readRegistry } from '../lib/registry.mjs';
import { t3Settings } from '../lib/setup.mjs';
import { decideWorktree, idleDays, parseWorktrees } from '../lib/upkeep.mjs';
import { assertInTmp, memReader, removeRepo, tempRepo, testGit } from './helpers.mjs';

const prs = [
  { headRefName: 'done', state: 'MERGED', headRefOid: 'p1' },
  { headRefName: 'open', state: 'OPEN', headRefOid: 'p2' },
  { headRefName: 'reopened', state: 'CLOSED', headRefOid: 'p3' },
  { headRefName: 'reopened', state: 'OPEN', headRefOid: 'p4' },
];
const base = { prs, containedIn: () => true, idleDays: 5, dirty: false };

test('decideWorktree keeps the same safety rules as repo-upkeep.sh', () => {
  assert.equal(decideWorktree({ ...base, branch: 'done' }).remove, true);
  assert.equal(decideWorktree({ ...base, branch: null }).reason, 'detached HEAD');
  assert.equal(decideWorktree({ ...base, branch: 'nopr' }).reason, 'no PR');
  assert.equal(decideWorktree({ ...base, branch: 'open' }).reason, 'PR open');
  assert.equal(decideWorktree({ ...base, branch: 'reopened' }).reason, 'PR open');
  assert.equal(decideWorktree({ ...base, branch: 'done', containedIn: () => false }).reason, 'unpushed');
  assert.equal(decideWorktree({ ...base, branch: 'done', idleDays: 1 }).reason, 'recently used');
  assert.equal(decideWorktree({ ...base, branch: 'done', dirty: true }).reason, 'uncommitted changes');
  assert.equal(decideWorktree({ ...base, branch: 'done', locked: true }).reason, 'locked');
  assert.equal(decideWorktree({ ...base, branch: 'open', locked: true }).reason, 'PR open');
  assert.match(decideWorktree({ ...base, branch: 'done', ignored: ['.env'] }).reason, /has ignored files \(\.env\)/);
});

test('parseWorktrees reads porcelain output', () => {
  const text = 'worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r/w1\nHEAD 2\ndetached\n\nworktree /r/w 2\nHEAD 3\nbranch refs/heads/fix/a\nlocked on a USB disk\n\n';
  assert.deepEqual(parseWorktrees(text), [
    { path: '/r', branch: 'main', detached: false, locked: false },
    { path: '/r/w1', branch: null, detached: true, locked: false },
    { path: '/r/w 2', branch: 'fix/a', detached: false, locked: true },
  ]);
});

const repos = [];
after(() => repos.forEach(removeRepo));

test('idleDays uses the index mtime (portable: no stat -f)', () => {
  const dir = tempRepo();
  repos.push(dir);
  const old = (Date.now() - 3 * 86_400_000) / 1000;
  utimesSync(join(dir, '.git', 'index'), old, old);
  assert.equal(idleDays(dir), 3);
  testGit(dir, ['status']);
});

test('registry: add, update by root, keep paths with spaces', () => {
  const dir = assertInTmp(mkdtempSync(join(tmpdir(), 'tug-reg-')));
  repos.push(dir);
  const path = join(dir, 'tug', 'repos');
  assert.equal(register({ root: '/a b/3ven', base: 'main', slug: 'o/3ven' }, path), true);
  assert.equal(register({ root: '/a b/3ven', base: 'main', slug: 'o/3ven' }, path), false);
  register({ root: '/x/aldrent', base: 'staging', slug: 'o/aldrent' }, path);
  register({ root: '/a b/3ven', base: 'staging', slug: 'o/3ven' }, path);
  assert.deepEqual(readRegistry(path), [
    { root: '/x/aldrent', base: 'staging', slug: 'o/aldrent' },
    { root: '/a b/3ven', base: 'staging', slug: 'o/3ven' },
  ]);
  assert.deepEqual(parseRegistry('# c\n\n/r main o/r\n'), [{ root: '/r', base: 'main', slug: 'o/r' }]);
});

test('install commands: bun runs the pinned version; T3 setup script installs on worktree creation', () => {
  const bun = detectPackageManager(memReader({ 'package.json': '{"packageManager":"bun@1.3.10"}', '.bun-version': '1.3.10\n' }));
  assert.equal(installCommand(bun), 'bunx bun@$(cat .bun-version) install --frozen-lockfile');
  assert.equal(installCommand(detectPackageManager(memReader({ 'package.json': '{"packageManager":"bun@1.3.10"}' }))), 'bunx bun@1.3.10 install --frozen-lockfile');
  const pnpm = detectPackageManager(memReader({ 'package.json': '{"packageManager":"pnpm@10.34.5"}' }));
  assert.deepEqual([pnpm.name, pnpm.pin], ['pnpm', '10.34.5']);
  assert.equal(installCommand(detectPackageManager(memReader({ 'package.json': '{}', 'package-lock.json': '{}' }))), 'npm ci');
  assert.equal(installCommand(detectPackageManager(memReader({}))), null);
  const text = t3Settings({ branch: 'staging', install: installCommand(bun) });
  assert.match(text, /from origin\/staging/);
  assert.match(text, /bunx bun@\$\(cat \.bun-version\) install --frozen-lockfile/);
});
