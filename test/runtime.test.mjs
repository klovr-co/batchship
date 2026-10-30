// Zero-install: the runtime tug init vendors into .agents/tug/, run from a temp repo that has no tug on PATH, with a
// temp HOME (the real ~/.claude and ~/.codex are never read or written).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { runtimeDrift, untrackedTugFiles } from '../lib/doctor.mjs';
import { guardHookChecks, PROJECT_HOOKS } from '../lib/harness.mjs';
import { LABELS, planInit, RUNTIME_FILES } from '../lib/init.mjs';
import { installGuardHooks } from '../lib/setup.mjs';
import { VERSION } from '../lib/version.mjs';
import { assertInTmp, commit, memReader, removeRepo, tempRepo, testGit } from './helpers.mjs';

const dirs = [];
after(() => dirs.forEach(removeRepo));
const byPath = plan => Object.fromEntries(plan.files.map(f => [f.path, f]));

function tempHome({ claude = false, codex = false } = {}) {
  const home = assertInTmp(mkdtempSync(join(realpathSync(tmpdir()), 'tug-home-')));
  dirs.push(home);
  if (claude) mkdirSync(join(home, '.claude'));
  if (codex) mkdirSync(join(home, '.codex'));
  return home;
}

/** A temp repo with everything tug init writes, committed. */
function initedRepo(files = {}) {
  const dir = tempRepo({ 'README.md': 'x\n', ...files });
  dirs.push(dir);
  const plan = planInit({ reader: memReader(files), defaultBranch: 'main', existingLabels: LABELS.map(l => l.name), org: 'acme' });
  for (const f of plan.files) {
    const path = join(dir, f.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.content);
    if (f.mode) chmodSync(path, f.mode);
  }
  commit(dir, {}, 'tug init');
  return { dir, plan };
}

/** Run a command with no tug on PATH (only node's own directory) and a temp HOME. */
function bare(cwd, cmd, args, { input = '', env = {} } = {}) {
  assertInTmp(cwd);
  const home = tempHome();
  return spawnSync(cmd, args, { cwd, input, encoding: 'utf8', env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'none'), ...env } });
}

test('the vendored set: every file a runtime file imports is vendored too, and nothing else is needed', () => {
  const lib = new URL('../lib/', import.meta.url);
  const set = new Set(RUNTIME_FILES);
  for (const file of RUNTIME_FILES) {
    const text = readFileSync(new URL(file, lib), 'utf8');
    assert.match(text, /^(#!.*\n)?\/\/ Part of tug\. `tug init` copies this file into \.agents\/tug\//, `${file} says it is vendored`);
    for (const m of text.matchAll(/^import .* from '(\.[^']+)';$/gm)) {
      const target = join(dirname(file), m[1]).replace(/^\.\//, '');
      assert.ok(set.has(target), `${file} imports ${m[1]}, which is not vendored`);
    }
  }
  for (const heavy of ['init.mjs', 'doctor.mjs', 'setup.mjs', 'upkeep.mjs', 'render.mjs', 'harness.mjs']) assert.ok(!set.has(heavy), `${heavy} stays in tug`);
});

test('node .agents/tug/tug.mjs works from a clone without tug: --version, ship --status, guard, usage errors', () => {
  const { dir, plan } = initedRepo();
  const files = byPath(plan);
  assert.ok(files['.agents/tug/tug.mjs'], 'the entry point is vendored');
  const lock = JSON.parse(files['.agents/tug.lock'].content);
  assert.equal(lock.version, VERSION);
  assert.deepEqual(Object.keys(lock.sha256).sort(), RUNTIME_FILES.map(f => `.agents/tug/${f}`).sort(), 'every vendored file is hashed in the lock');
  const run = (...args) => bare(dir, process.execPath, ['.agents/tug/tug.mjs', ...args]);
  assert.equal(run('--version').stdout.trim(), VERSION);
  const status = run('ship', '--status', '5');
  assert.equal(status.status, 1);
  assert.match(status.stdout, /tug ship #5: no state on this machine/);
  assert.equal(run('ship', '05').status, 1);
  assert.equal(run('ship', '5', '--bogus').status, 1);
  assert.equal(run('guard').status, 0, 'nothing tracked: the turn may end');
  const init = run('init');
  assert.equal(init.status, 1);
  assert.match(init.stderr, /tug init needs tug installed/);
});

test('project-level hooks: the committed Claude Code and Codex commands run the repo\'s guard (probe answered)', () => {
  const { dir, plan } = initedRepo();
  const files = byPath(plan);
  const claude = JSON.parse(files['.claude/settings.json'].content);
  assert.deepEqual(claude.hooks.Stop, [{ hooks: [{ type: 'command', command: PROJECT_HOOKS.claude.command, timeout: 30 }] }]);
  const codex = JSON.parse(files['.codex/hooks.json'].content);
  assert.equal(codex.hooks.Stop[0].hooks[0].command, PROJECT_HOOKS.codex.command);
  assert.equal(codex.hooks.Stop[0].hooks[0].timeout, 30);
  const probe = JSON.stringify({ hook_event_name: 'Stop', session_id: 'p', tug_probe: true });
  const sub = join(dir, 'sub');
  mkdirSync(sub);
  const c = bare(sub, '/bin/sh', ['-c', PROJECT_HOOKS.claude.command], { input: probe, env: { CLAUDE_PROJECT_DIR: dir } });
  assert.equal(c.stdout.trim(), '{"tug_probe":"ok"}', c.stderr);
  const x = bare(sub, '/bin/sh', ['-c', PROJECT_HOOKS.codex.command], { input: probe });
  assert.equal(x.stdout.trim(), '{"tug_probe":"ok"}', x.stderr);
});

test('project-level hooks merge into the repo\'s own files and never clobber them', () => {
  const own = { enabledPlugins: { 'batchship@batchship': false }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './check.sh' }] }] } };
  const tree = { '.claude/settings.json': `${JSON.stringify(own, null, 2)}\n` };
  const plan = planInit({ reader: memReader(tree), defaultBranch: 'main' });
  const merged = JSON.parse(byPath(plan)['.claude/settings.json'].content);
  assert.deepEqual(merged.enabledPlugins, own.enabledPlugins);
  assert.deepEqual(merged.hooks.PreToolUse, own.hooks.PreToolUse);
  assert.equal(merged.hooks.Stop[0].hooks[0].command, PROJECT_HOOKS.claude.command);
  assert.equal(byPath(plan)['.claude/settings.json'].action, 'update');
  // Run again over the result: nothing to change.
  const again = planInit({ reader: memReader({ ...Object.fromEntries(plan.files.map(f => [f.path, f.content])) }), defaultBranch: 'main' });
  assert.ok(!byPath(again)['.claude/settings.json'] && !byPath(again)['.codex/hooks.json']);
  // A file tug cannot read is left alone, with a note.
  const broken = planInit({ reader: memReader({ '.codex/hooks.json': '{ not json' }), defaultBranch: 'main' });
  assert.ok(!byPath(broken)['.codex/hooks.json']);
  assert.match(broken.skipped.find(s => s.path === '.codex/hooks.json').why, /could not add the guard's Stop hook/);
});

test('setup installs no user-level hook for a harness the repo already hooks; doctor reports the project-level one', () => {
  const { dir } = initedRepo();
  const home = tempHome({ claude: true, codex: true });
  const env = { HOME: home };
  const results = installGuardHooks({ env, root: dir, command: () => "'/x/node' '/x/tug.mjs' guard --hook claude" });
  assert.equal(results.length, 2);
  for (const r of results) assert.match(r.text, /project-level\); no user-level hook installed/);
  assert.ok(!existsSync(join(home, '.claude/settings.json')) && !existsSync(join(home, '.codex/hooks.json')), 'nothing written under HOME');
  // Without project hooks, setup still installs the user-level one.
  const plain = tempRepo();
  dirs.push(plain);
  const user = installGuardHooks({ env: { HOME: tempHome({ claude: true }) }, root: plain, command: () => "'/x/node' '/x/tug.mjs' guard --hook claude" });
  assert.match(user[0].text, /Stop hook installed in/);
  // Doctor: probes the project command with CLAUDE_PROJECT_DIR set to the repo.
  const seen = [];
  const checks = guardHookChecks({ cwd: dir, env: { HOME: tempHome() }, probe: (command, opts) => { seen.push([command, opts.env.CLAUDE_PROJECT_DIR]); return { ok: true }; } });
  assert.deepEqual(checks.map(c => c.ok), [true, true]);
  assert.match(checks[0].detail, /project-level \(\.claude\/settings\.json\) installed and fires/);
  assert.match(checks[1].detail, /project's \.codex\/ is trusted/);
  assert.deepEqual(seen[0], [PROJECT_HOOKS.claude.command, dir]);
});

test('doctor: runtime drift (another kit version, edited by hand, missing) and tug files that never reached git', () => {
  const { dir } = initedRepo();
  assert.deepEqual(runtimeDrift(dir).filter(d => d.state !== 'ok'), []);
  assert.deepEqual(untrackedTugFiles(dir), []);
  writeFileSync(join(dir, '.agents/tug/ship.mjs'), '// edited\n');
  const older = runtimeDrift(dir, { kit: f => (f === 'gh.mjs' ? 'a newer kit\n' : readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8')) });
  assert.deepEqual(older.filter(d => d.state !== 'ok').map(d => [d.path, d.state]).sort(), [['.agents/tug/gh.mjs', 'older'], ['.agents/tug/ship.mjs', 'edited']]);
  // aldrent's case: `.agents/` ignored, so the runtime never got committed.
  const lost = tempRepo({ 'README.md': 'x\n', '.gitignore': '.agents/\n' });
  dirs.push(lost);
  mkdirSync(join(lost, '.agents/tug/checks'), { recursive: true });
  writeFileSync(join(lost, '.agents/config.yml'), 'shipTarget: production\n');
  writeFileSync(join(lost, '.agents/tug.lock'), JSON.stringify({ version: VERSION, files: ['.agents/tug/git.mjs'] }));
  const bad = untrackedTugFiles(lost);
  assert.deepEqual(bad.map(b => b.path).sort(), ['.agents/config.yml', '.agents/tug.lock', '.agents/tug/git.mjs']);
  assert.match(bad[0].rule, /\.gitignore:1:\.agents\//);
  testGit(lost, ['status', '--short']);
});
