import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { detectHookManager, GATE_COMMAND, hookStatus, wireHook } from '../lib/hooks.mjs';
import { hookPlan } from '../lib/setup.mjs';
import { template } from '../lib/render.mjs';
import { parseYaml } from '../lib/yaml.mjs';
import { memReader, removeRepo, tempRepo, testGit, writeFiles } from './helpers.mjs';

const LEFTHOOK_WITH_PRE_PUSH = 'pre-commit:\n  jobs:\n    - run: biome format\npre-push:\n  jobs:\n    - name: gate\n      run: node scripts/pre-push-check.mjs\n';

test('detects the hook manager', () => {
  assert.equal(detectHookManager(memReader({})).manager, 'githooks');
  assert.equal(detectHookManager(memReader({ 'lefthook.yml': 'pre-commit: {}\n' })).manager, 'lefthook');
  assert.equal(detectHookManager(memReader({ '.husky/pre-commit': 'x' })).manager, 'husky');
  assert.equal(detectHookManager(memReader({ 'package.json': '{"simple-git-hooks":{"pre-commit":"x"}}' })).manager, 'simple-git-hooks');
  assert.equal(detectHookManager(memReader({ 'package.json': '{"pre-commit":["lint"]}' })).manager, 'npm-pre-push');
  assert.equal(detectHookManager(memReader({ 'package.json': '{"husky":{"hooks":{"pre-commit":"lint"}}}' })).manager, 'husky4');
  assert.equal(detectHookManager(memReader({ '.pre-commit-config.yaml': 'repos: []\n' })).manager, 'pre-commit');
  const aldrent = detectHookManager(memReader({ 'lefthook.yml': LEFTHOOK_WITH_PRE_PUSH }));
  assert.deepEqual([aldrent.hasPrePush, aldrent.wired], [true, false]);
});

test('wiring: .githooks only without a manager; lefthook gets a pre-push section appended; existing ones are left', () => {
  const tpl = template('githooks/pre-push');
  assert.deepEqual(wireHook(detectHookManager(memReader({})), memReader({}), { template: tpl }), { path: '.githooks/pre-push', content: tpl, mode: 0o755 });
  const own = memReader({ '.githooks/pre-push': '#!/bin/sh\nnode scripts/check.mjs\n' });
  assert.ok(wireHook(detectHookManager(own), own, { template: tpl }).manual, 'never overwrites a repo\'s own .githooks/pre-push');
  assert.equal(wireHook(detectHookManager(own), own, { template: tpl, force: true }).path, '.githooks/pre-push');

  const lh = memReader({ 'lefthook.yml': 'pre-commit:\n  commands:\n    fmt:\n      run: fmt\n' });
  const wired = wireHook(detectHookManager(lh), lh, { template: tpl });
  assert.equal(wired.path, 'lefthook.yml');
  const doc = parseYaml(wired.content);
  assert.deepEqual(doc['pre-push'], { commands: { tug: { run: GATE_COMMAND, use_stdin: true } } });
  assert.deepEqual(doc['pre-commit'], { commands: { fmt: { run: 'fmt' } } });

  const al = memReader({ 'lefthook.yml': LEFTHOOK_WITH_PRE_PUSH });
  const manual = wireHook(detectHookManager(al), al, { template: tpl });
  assert.match(manual.manual, /own pre-push section/);
  assert.equal(wireHook(detectHookManager(memReader({ '.husky/pre-commit': 'x' })), memReader({ '.husky/pre-commit': 'x' }), { template: tpl }).path, '.husky/pre-push');
  const done = memReader({ 'lefthook.yml': `pre-push:\n  commands:\n    tug:\n      run: ${GATE_COMMAND}\n` });
  assert.deepEqual(wireHook(detectHookManager(done), done, { template: tpl }), { already: true });
});

test('setup never sets core.hooksPath under a hook manager, and unsets .githooks there', () => {
  assert.deepEqual(hookPlan('githooks', null).args, ['config', 'core.hooksPath', '.githooks']);
  assert.equal(hookPlan('githooks', '.githooks').action, 'none');
  assert.equal(hookPlan('githooks', '.custom').action, 'none');
  assert.deepEqual(hookPlan('lefthook', '.githooks').args, ['config', '--unset', 'core.hooksPath']);
  assert.equal(hookPlan('lefthook', null).action, 'none');
  assert.equal(hookPlan('husky', '.husky/_').action, 'none');
  const lfs = hookPlan('githooks', null, ['post-checkout', 'pre-push']);
  assert.equal(lfs.action, 'none', 'never bypasses hooks already in .git/hooks (git-lfs)');
  assert.match(lfs.message, /pre-push/);
});

const repos = [];
after(() => repos.forEach(removeRepo));

test('hookStatus in a temp repo: off until core.hooksPath points at .githooks', () => {
  const dir = tempRepo({ '.githooks/pre-push': template('githooks/pre-push') });
  repos.push(dir);
  chmodSync(join(dir, '.githooks/pre-push'), 0o755);
  const reader = { read: p => { try { return testGit(dir, ['show', `HEAD:${p}`]); } catch { return null; } }, exists: p => !!reader.read(p), isDir: () => false };
  const detected = detectHookManager(reader);
  assert.equal(hookStatus(dir, detected).ok, false);
  testGit(dir, ['config', 'core.hooksPath', '.githooks']);
  const on = hookStatus(dir, detected);
  assert.equal(on.ok, true, on.detail);
});

test('hookStatus in a temp repo: lefthook with core.hooksPath=.githooks is reported as off', () => {
  const dir = tempRepo({ 'lefthook.yml': `pre-push:\n  commands:\n    tug:\n      run: ${GATE_COMMAND}\n` });
  repos.push(dir);
  writeFiles(dir, { '.git/hooks/pre-push': '#!/bin/sh\n# lefthook\nlefthook run pre-push "$@"\n' });
  chmodSync(join(dir, '.git/hooks/pre-push'), 0o755);
  const reader = { read: p => (p === 'lefthook.yml' ? testGit(dir, ['show', 'HEAD:lefthook.yml']) : null), exists: p => p === 'lefthook.yml', isDir: () => false };
  const detected = detectHookManager(reader);
  assert.equal(hookStatus(dir, detected).ok, true, hookStatus(dir, detected).detail);
  testGit(dir, ['config', 'core.hooksPath', '.githooks']);
  assert.equal(hookStatus(dir, detected).ok, false);
});
