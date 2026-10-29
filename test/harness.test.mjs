// Hook installation, always into a temp HOME: the real ~/.claude and ~/.codex are never read or written.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { codexHooksDisabled, detectHarnesses, guardCommand, guardHookChecks, harnesses, installedGuard, installGuard, isGuardCommand, mergeGuardHook, probeGuard } from '../lib/harness.mjs';
import { installGuardHooks } from '../lib/setup.mjs';
import { assertInTmp, removeRepo, tempRepo } from './helpers.mjs';

const dirs = [];
after(() => dirs.forEach(removeRepo));
function tempHome({ claude = true, codex = false } = {}) {
  const home = assertInTmp(mkdtempSync(join(realpathSync(tmpdir()), 'tug-home-')));
  dirs.push(home);
  if (claude) mkdirSync(join(home, '.claude'));
  if (codex) mkdirSync(join(home, '.codex'));
  return { HOME: home };
}
const CMD = "'/usr/bin/node' '/opt/tug/bin/tug.mjs' guard --hook claude";
const EXISTING = {
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'say done', timeout: 5 }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh' }] }],
  },
};

test('mergeGuardHook adds one Stop hook and keeps everything else; idempotent; moves an old path in place', () => {
  const { settings, changed } = mergeGuardHook(EXISTING, CMD);
  assert.equal(changed, true);
  assert.deepEqual(settings.hooks.Stop[0], EXISTING.hooks.Stop[0]);
  assert.deepEqual(settings.hooks.Stop[1], { hooks: [{ type: 'command', command: CMD, timeout: 30 }] });
  assert.deepEqual(settings.hooks.PreToolUse, EXISTING.hooks.PreToolUse);
  assert.equal(settings.model, 'opus');
  assert.deepEqual(EXISTING.hooks.Stop.length, 1, 'input not mutated');
  assert.equal(mergeGuardHook(settings, CMD).changed, false);
  const moved = mergeGuardHook(settings, CMD.replace('/opt/tug', '/new/tug'));
  assert.equal(moved.changed, true);
  assert.equal(moved.settings.hooks.Stop.length, 2);
  assert.match(moved.settings.hooks.Stop[1].hooks[0].command, /\/new\/tug/);
  assert.deepEqual(mergeGuardHook(null, CMD).settings, { hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD, timeout: 30 }] }] } });
  assert.throws(() => mergeGuardHook({ hooks: [] }, CMD), /"hooks" is not an object/);
  assert.throws(() => mergeGuardHook({ hooks: { Stop: {} } }, CMD), /not a list/);
  assert.ok(isGuardCommand(CMD) && isGuardCommand('tug guard --hook codex') && !isGuardCommand('say done'));
});

test('installGuard into a temp HOME: merges, keeps a backup, reads back; a second run changes nothing', () => {
  const env = tempHome();
  const [claude] = harnesses(env);
  writeFileSync(claude.path, JSON.stringify(EXISTING, null, 2));
  const r = installGuard(claude, { command: CMD });
  assert.equal(r.changed, true);
  assert.deepEqual(JSON.parse(readFileSync(r.backup, 'utf8')), EXISTING);
  const after = JSON.parse(readFileSync(claude.path, 'utf8'));
  assert.deepEqual(after.hooks.PreToolUse, EXISTING.hooks.PreToolUse);
  assert.deepEqual(after.hooks.Stop[0], EXISTING.hooks.Stop[0]);
  assert.deepEqual(after.permissions, EXISTING.permissions);
  assert.equal(installedGuard(claude.path), CMD);
  assert.equal(installGuard(claude, { command: CMD }).changed, false);
});

test('installGuard leaves a broken or odd file alone', () => {
  const env = tempHome();
  const [claude] = harnesses(env);
  writeFileSync(claude.path, '{ "hooks": { oops');
  assert.throws(() => installGuard(claude, { command: CMD }), /not valid JSON.*left alone/);
  assert.equal(readFileSync(claude.path, 'utf8'), '{ "hooks": { oops');
  writeFileSync(claude.path, '{"hooks": {"Stop": "x"}}');
  assert.throws(() => installGuard(claude, { command: CMD }), /not a list/);
  assert.equal(readFileSync(claude.path, 'utf8'), '{"hooks": {"Stop": "x"}}');
});

test('setup installs for the harnesses it finds (CLAUDE_CONFIG_DIR and CODEX_HOME respected), nowhere else', () => {
  const env = tempHome({ claude: false, codex: true });
  assert.deepEqual(detectHarnesses(env).map(h => h.name), ['codex']);
  const lines = installGuardHooks({ env, command: name => `tug guard --hook ${name}` });
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /Codex Stop hook installed in .*\.codex\/hooks\.json.*trust/);
  assert.equal(installedGuard(join(env.HOME, '.codex/hooks.json')), 'tug guard --hook codex');
  assert.ok(!existsSync(join(env.HOME, '.claude')), 'no Claude Code here: nothing created');
  const custom = assertInTmp(mkdtempSync(join(realpathSync(tmpdir()), 'tug-cfg-')));
  dirs.push(custom);
  assert.equal(harnesses({ HOME: env.HOME, CLAUDE_CONFIG_DIR: custom })[0].path, join(custom, 'settings.json'));
  assert.equal(installGuardHooks({ env: tempHome({ claude: false }), command: () => 'x' })[0].ok, null);
});

test('codexHooksDisabled reads [features] hooks = false', () => {
  assert.equal(codexHooksDisabled('[features]\nhooks = false\n'), true);
  assert.equal(codexHooksDisabled('[features]\ncodex_hooks = false # old\n'), true);
  assert.equal(codexHooksDisabled('[other]\nhooks = false\n[features]\nhooks = true\n'), false);
  assert.equal(codexHooksDisabled(''), false);
});

test('doctor: the installed command really fires (a probe through this tug), or says why not', () => {
  const env = tempHome({ claude: true, codex: true });
  const repo = tempRepo();
  dirs.push(repo);
  const real = guardCommand('claude');
  installGuard(harnesses(env)[0], { command: real });
  const probe = probeGuard(real, { cwd: repo, env: { ...process.env, ...env } });
  assert.deepEqual(probe, { ok: true, detail: 'fires (probe answered)' });
  const checks = guardHookChecks({ cwd: repo, env });
  assert.equal(checks.length, 2);
  assert.deepEqual([checks[0].name, checks[0].ok], ['guard hook (Claude Code)', true]);
  assert.deepEqual([checks[1].ok, /not installed/.test(checks[1].detail)], [false, true]);
  installGuard(harnesses(env)[1], { command: "'/nonexistent/node' '/x/tug.mjs' guard --hook codex" });
  const broken = guardHookChecks({ cwd: repo, env })[1];
  assert.equal(broken.ok, false);
  assert.match(broken.detail, /does not run/);
});

test('installGuard writes through a symlink, keeps the mode and the first backup, and removes duplicate guards', () => {
  const env = tempHome();
  const [claude] = harnesses(env);
  const target = join(env.HOME, 'dotfiles-settings.json');
  writeFileSync(target, JSON.stringify(EXISTING));
  chmodSync(target, 0o600);
  symlinkSync(target, claude.path);
  installGuard(claude, { command: CMD });
  assert.ok(lstatSync(claude.path).isSymbolicLink(), 'the link is still a link');
  assert.equal(installedGuard(target), CMD);
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(`${target}.tug-backup`, 'utf8')), EXISTING);
  installGuard(claude, { command: CMD.replace('/opt/', '/new/') });
  assert.deepEqual(JSON.parse(readFileSync(`${target}.tug-backup`, 'utf8')), EXISTING, 'the backup is the pre-tug file');
  const doubled = { hooks: { Stop: [{ hooks: [{ type: 'command', command: CMD }] }, { hooks: [{ type: 'command', command: 'say hi' }, { type: 'command', command: 'tug guard --hook claude' }] }] } };
  const { settings } = mergeGuardHook(doubled, CMD);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: CMD }] }, { hooks: [{ type: 'command', command: 'say hi' }] }]);
});
