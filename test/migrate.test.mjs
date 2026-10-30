// From tug (the kit's name until 1.1.1) to shiplane: init migrates a repo's tug 1.1.0 files in the same PRs, setup
// moves the user-level hooks and the registry, doctor reports what is left. Repos and HOME dirs are temp dirs only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { harnesses, installedGuard } from '../lib/harness.mjs';
import { applyInit, LABELS, planInit } from '../lib/init.mjs';
import { isLegacyGuardCommand, legacyRegistryPath, migrateGitignore, migrateHookText, moveLegacyRegistry, tugLeftovers } from '../lib/migrate.mjs';
import { readRegistry, registryPath, upkeepEntries, writeRegistry } from '../lib/registry.mjs';
import { agentsBlockInfo, upsertAgentsBlock } from '../lib/render.mjs';
import { installGuardHooks } from '../lib/setup.mjs';
import { VERSION } from '../lib/version.mjs';
import { assertInTmp, memReader, tempRepo, testGit } from './helpers.mjs';

const dirs = [];
after(() => dirs.forEach(d => rmSync(assertInTmp(d), { recursive: true, force: true })));
const sha = t => createHash('sha256').update(t).digest('hex');
const byPath = list => Object.fromEntries(list.map(f => [f.path, f]));

const TUG_GUARD_CLAUDE = 'node "${CLAUDE_PROJECT_DIR:-.}/.agents/tug/tug.mjs" guard --hook claude';
const OLD_RUNTIME = ['tug.mjs', 'pre-push.mjs', 'config.mjs', 'git.mjs', 'yaml.mjs', 'pm.mjs', 'checks/line-endings.mjs', 'checks/generated-current.mjs'];

/** A repo as tug 1.1.0 left it (aldrent's shape: lefthook, .agents/* ignored with exceptions, both project hooks). */
function tugRepoFiles() {
  const runtime = Object.fromEntries(OLD_RUNTIME.map(f => [`.agents/tug/${f}`, `// Part of tug. ${f}\n`]));
  const lock = { version: '1.1.0', files: Object.keys(runtime).sort(), sha256: Object.fromEntries(Object.entries(runtime).map(([p, t]) => [p, sha(t)])) };
  return {
    ...runtime,
    '.agents/tug/NOTES.md': 'the repo\'s own note, not tug\'s\n',
    '.agents/tug.lock': `${JSON.stringify(lock, null, 2)}\n`,
    '.agents/config.yml': '# Settings every agent and every tug command reads (https://github.com/klovr-co/tug).\n# Extra comment lines kept at the top of .github/workflows/tug-events.yml\nshipTarget: staging\nbranches:\n  production: main\n  staging: staging\nowners:\n  - alice\n',
    'AGENTS.md': '# Rules\n\nKeep this.\n\n<!-- tug:start v1.1.0 -->\n## Shipping (managed by tug; settings in .agents/config.yml)\n1. old rule\n<!-- tug:end -->\n\n## After the block\nAlso keep this.\n',
    'lefthook.yml': 'pre-commit:\n  jobs:\n    - run: biome format\n\npre-push:\n  commands:\n    lint:\n      run: eslint .\n    # tug pre-push gate (.agents/tug/pre-push.mjs): line endings, generated files, checkCommand.\n    tug:\n      run: node .agents/tug/pre-push.mjs --hook\n      use_stdin: true\n',
    '.gitignore': 'node_modules/\n.agents/*\n!.agents/config.yml\n!.agents/tug/\n!.agents/tug.lock\n.agents/state/\n',
    '.claude/settings.json': `${JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }], Stop: [{ hooks: [{ type: 'command', command: TUG_GUARD_CLAUDE, timeout: 30 }] }] } }, null, 2)}\n`,
    '.codex/hooks.json': `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$(git rev-parse --show-toplevel)/.agents/tug/tug.mjs" guard --hook codex', timeout: 30 }] }] } }, null, 2)}\n`,
    '.mergify.yml': '# Managed by tug 1.1.0 from .agents/config.yml: `tug init` rewrites this file.\nqueue_rules: []\n',
    '.github/workflows/ci.yml': 'name: CI\non:\n  pull_request:\njobs:\n  gate:\n    name: CI result\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
    '.github/workflows/tug-events.yml': '# Managed by tug 1.1.0 from .agents/config.yml: `tug init` rewrites this file. Change the config, not this file.\n# Dry run: labelled a test PR needs-owner.\n# Revert: gh workflow disable tug-events.yml -R acme/app (stops it at once); git revert <this commit> removes it.\nname: tug events\non: {}\n',
    'scripts/ci-budget.baseline.json': '{\n  "workflows": {\n    "ci.yml": "CI",\n    "tug-events.yml": "tug notifications"\n  }\n}\n',
    'package.json': '{ "name": "app", "scripts": { "prepare": "lefthook install" } }\n',
  };
}

test('migration: init moves every tug artefact in the same PRs and keeps the repo\'s own content', () => {
  const files = tugRepoFiles();
  const plan = planInit({ reader: memReader(files), defaultBranch: 'main', existingLabels: LABELS.map(l => l.name), org: 'acme' });
  const out = byPath(plan.files);

  // .agents/tug/ -> .agents/shiplane/: kit files deleted (re-written as shiplane's), the repo's own file moved unchanged.
  for (const f of OLD_RUNTIME) assert.equal(out[`.agents/tug/${f}`]?.action, 'delete', f);
  assert.equal(out['.agents/tug.lock'].action, 'delete');
  assert.equal(out['.agents/tug/NOTES.md'].action, 'delete');
  assert.equal(out['.agents/shiplane/NOTES.md'].content, files['.agents/tug/NOTES.md']);
  assert.equal(out['.agents/shiplane/shiplane.mjs'].action, 'create');
  assert.equal(out['.agents/shiplane/pre-push.mjs'].action, 'create');
  const lock = JSON.parse(out['.agents/shiplane.lock'].content);
  assert.equal(lock.version, VERSION);
  assert.ok(lock.files.every(f => !f.startsWith('.agents/tug')));

  // AGENTS.md: the tug block replaced in place by one shiplane block; everything else byte-for-byte.
  const agents = out['AGENTS.md'].content;
  assert.ok(!/tug:start|tug:end/.test(agents));
  assert.equal(agents.match(/<!-- shiplane:start/g).length, 1);
  assert.ok(agents.startsWith('# Rules\n\nKeep this.\n\n<!-- shiplane:start v'));
  assert.ok(agents.endsWith('<!-- shiplane:end -->\n\n## After the block\nAlso keep this.\n'));
  assert.match(out['AGENTS.md'].why, /replace the tug block with the shiplane block/);

  // lefthook: the gate's path, key and comment move; every other line stays.
  const lefthook = out['lefthook.yml'].content;
  assert.equal(lefthook, files['lefthook.yml'].replace('# tug pre-push gate (.agents/tug/', '# shiplane pre-push gate (.agents/shiplane/').replace('    tug:\n      run: node .agents/tug/', '    shiplane:\n      run: node .agents/shiplane/'));

  // .gitignore exceptions follow.
  assert.equal(out['.gitignore'].content, 'node_modules/\n.agents/*\n!.agents/config.yml\n!.agents/shiplane/\n!.agents/shiplane.lock\n.agents/state/\n');

  // .agents/config.yml: its comments follow, in the init PR; no value changes.
  assert.equal(out['.agents/config.yml'].content.split('\n').slice(0, 2).join('\n'), '# Settings every agent and every tug command reads (https://github.com/klovr-co/tug).\n# Extra comment lines kept at the top of .github/workflows/tug-events.yml'.replace(/tug/g, 'shiplane'));
  assert.ok(out['.agents/config.yml'].content.includes('shipTarget: staging\nbranches:\n  production: main\n  staging: staging\nowners:\n  - alice\n'));

  // Project hooks: tug's guard command replaced in place, nothing else touched.
  const claude = JSON.parse(out['.claude/settings.json'].content);
  assert.deepEqual(claude.permissions, { allow: ['Bash(ls)'] });
  assert.deepEqual(claude.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }]);
  assert.equal(claude.hooks.Stop.length, 1);
  assert.equal(claude.hooks.Stop[0].hooks[0].command, 'node "${CLAUDE_PROJECT_DIR:-.}/.agents/shiplane/shiplane.mjs" guard --hook claude');
  assert.match(JSON.parse(out['.codex/hooks.json'].content).hooks.Stop[0].hooks[0].command, /\.agents\/shiplane\/shiplane\.mjs" guard --hook codex$/);

  // .mergify.yml was tug's: re-rendered as shiplane's.
  assert.match(out['.mergify.yml'].content, /^# Managed by shiplane /);

  // Events PR: renamed, its Dry run/Revert lines kept (naming the new file), other mentions follow.
  const ci = byPath(plan.ciFiles);
  assert.equal(ci['.github/workflows/tug-events.yml'].action, 'delete');
  const events = ci['.github/workflows/shiplane-events.yml'].content;
  assert.match(events, /^# Managed by shiplane /);
  assert.match(events, /^name: shiplane events$/m);
  assert.match(events, /^# Dry run: labelled a test PR needs-owner\.$/m);
  assert.match(events, /^# Revert: gh workflow disable shiplane-events\.yml -R acme\/app \(stops it at once\); git revert <this commit> removes it\.$/m);
  assert.equal(ci['.agents/config.yml'], undefined, 'config.yml is changed in the init PR only');
  assert.equal(ci['scripts/ci-budget.baseline.json'].content, files['scripts/ci-budget.baseline.json'].replace('"tug-events.yml"', '"shiplane-events.yml"'));
  assert.ok(!plan.files.some(f => f.path.startsWith('.github/')), '.github/ changes stay in the events PR');
  assert.ok(plan.notes.some(n => /Moves this repo from tug to shiplane/.test(n)));
  assert.ok(plan.notes.some(n => /NOTES\.md; moved under \.agents\/shiplane\/ unchanged/.test(n)));

  // Run again on the result: nothing of tug is left to move, and the plan is empty.
  const result = { ...files };
  for (const f of [...plan.files, ...plan.ciFiles]) {
    if (f.action === 'delete') delete result[f.path];
    else result[f.path] = f.content;
  }
  const again = planInit({ reader: memReader(result), defaultBranch: 'staging', existingLabels: LABELS.map(l => l.name), org: 'acme' });
  assert.deepEqual(again.files.map(f => f.path), []);
  assert.deepEqual(again.ciFiles.map(f => f.path), []);
  assert.ok(!Object.keys(result).some(p => /(^|\/)tug[.-]|\.agents\/tug/.test(p)), Object.keys(result).join(', '));
});

test('migration: a hand-edited tug runtime file is named; a repo file that already exists in .agents/shiplane/ is left for a person', () => {
  const files = tugRepoFiles();
  files['.agents/tug/pre-push.mjs'] += '// local edit\n';
  files['.agents/shiplane/NOTES.md'] = 'already here\n';
  const plan = planInit({ reader: memReader(files), defaultBranch: 'staging', org: 'acme' });
  assert.ok(plan.notes.some(n => /\.agents\/tug\/pre-push\.mjs was edited by hand after tug wrote it/.test(n)));
  assert.ok(plan.notes.some(n => /\.agents\/tug\/NOTES\.md is not one of tug's files and \.agents\/shiplane\/NOTES\.md already exists: both kept/.test(n)));
  assert.ok(!plan.files.some(f => f.path === '.agents/tug/NOTES.md'), 'not deleted');
  assert.ok(!plan.files.some(f => f.path === '.agents/shiplane/NOTES.md'), 'not overwritten');
});

test('migration: husky and .githooks hooks that call .agents/tug/ are moved; the repo\'s own hook is kept', () => {
  const husky = { '.husky/pre-push': '#!/bin/sh\nnpm test\n# tug pre-push gate (reads what is left of git\'s stdin; with none it checks HEAD).\nnode .agents/tug/pre-push.mjs --hook "$@"\n', '.agents/tug/pre-push.mjs': 'x\n' };
  const h = byPath(planInit({ reader: memReader(husky), defaultBranch: 'main' }).files);
  assert.equal(h['.husky/pre-push'].content, '#!/bin/sh\nnpm test\n# shiplane pre-push gate (reads what is left of git\'s stdin; with none it checks HEAD).\nnode .agents/shiplane/pre-push.mjs --hook "$@"\n');

  const githooks = {
    '.githooks/pre-push': '#!/bin/sh\n# Managed by tug: the pre-push gate (.agents/tug/pre-push.mjs).\nprintf \'%s\\n\' "$input" | ./.githooks/pre-push.repo "$@" || exit 1\nnode .agents/tug/pre-push.mjs --hook "$@"\n',
    '.githooks/pre-push.repo': '#!/bin/sh\necho the repo\'s own check\n',
    '.agents/tug/pre-push.mjs': 'x\n',
  };
  const g = byPath(planInit({ reader: memReader(githooks), defaultBranch: 'main' }).files);
  assert.match(g['.githooks/pre-push'].content, /^# Managed by shiplane/m);
  assert.match(g['.githooks/pre-push'].content, /\.\/\.githooks\/pre-push\.repo "\$@" \|\| exit 1/, 'still runs the repo\'s hook first');
  assert.ok(!g['.githooks/pre-push'].content.includes('.agents/tug'));
  assert.equal(g['.githooks/pre-push.repo'], undefined, 'the repo\'s own hook is unchanged');

  // Only the gate's lines change: a `tug:` key that runs something else is the repo's.
  assert.equal(migrateHookText('pre-push:\n  commands:\n    tug:\n      run: ./pull-boat.sh\n'), 'pre-push:\n  commands:\n    tug:\n      run: ./pull-boat.sh\n');
  assert.equal(migrateGitignore('# .agents/tug/ is the kit\n/.agents/tug/**\n!.agents/tug.lock\r\n.agents/tugboat/\n'), '# .agents/tug/ is the kit\n/.agents/shiplane/**\n!.agents/shiplane.lock\r\n.agents/tugboat/\n');
});

test('migration: AGENTS.md with both a tug and a shiplane block keeps one shiplane block; broken markers still throw', () => {
  const both = 'Top.\n\n<!-- tug:start v1.1.0 -->\nold\n<!-- tug:end -->\n\nMiddle.\n\n<!-- shiplane:start v1.1.0 -->\nnewer\n<!-- shiplane:end -->\n\nEnd.\n';
  const out = upsertAgentsBlock(both, '<!-- shiplane:start v9 -->\nnew\n<!-- shiplane:end -->');
  assert.equal(out, 'Top.\n\nMiddle.\n\n<!-- shiplane:start v9 -->\nnew\n<!-- shiplane:end -->\n\nEnd.\n');
  assert.deepEqual(agentsBlockInfo(both), { version: '1.1.0', legacy: '1.1.0' });
  assert.deepEqual(agentsBlockInfo(out), { version: '9', legacy: null });
  const crlf = 'A\r\n\r\n<!-- tug:start v1.1.0 -->\r\nold\r\n<!-- tug:end -->\r\n';
  assert.equal(upsertAgentsBlock(crlf, '<!-- shiplane:start v9 -->\nnew\n<!-- shiplane:end -->'), 'A\r\n\r\n<!-- shiplane:start v9 -->\r\nnew\r\n<!-- shiplane:end -->\r\n');
  assert.throws(() => upsertAgentsBlock('<!-- tug:start v1 -->\nno end\n', 'x'), /without <!-- tug:end -->/);
});

/** A repo with origin = a bare repo next to it (no hooks), holding the given files. */
function repoWithOrigin(files) {
  const dir = tempRepo(files);
  dirs.push(dir);
  const bare = `${assertInTmp(dir)}-origin.git`;
  mkdirSync(bare);
  dirs.push(assertInTmp(bare));
  testGit(bare, ['init', '-q', '--bare', '-b', 'main']);
  testGit(dir, ['remote', 'add', 'origin', bare]);
  testGit(dir, ['push', '-q', '--no-verify', 'origin', 'main']);
  return { dir, bare };
}

test('migration end to end: the init PR deletes .agents/tug/ and the lock in git; the events PR renames the workflow', async () => {
  const files = tugRepoFiles();
  files['.agents/config.yml'] = 'shipTarget: production\nbranches:\n  production: main\n  staging: null\nowners:\n  - alice\n';
  delete files['lefthook.yml'];
  delete files['package.json'];
  const { dir, bare } = repoWithOrigin(files);
  const prs = [];
  const client = { labels: () => LABELS.map(l => l.name), createLabel: () => {}, setDefaultBranch: () => {}, createPr: pr => (prs.push(pr), `https://github.com/acme/app/pull/${prs.length}`) };
  const lines = [];
  const code = await applyInit({ cwd: dir, client, info: { slug: 'acme/app', defaultBranch: 'main' }, log: t => lines.push(String(t)), install: false });
  assert.equal(code, 0, lines.join('\n'));
  const tree = ref => testGit(bare, ['ls-tree', '-r', '--name-only', ref]).split('\n').filter(Boolean);
  const init = tree(`shiplane/init-v${VERSION}`);
  assert.ok(!init.some(p => p.startsWith('.agents/tug')), init.join(', '));
  for (const p of ['.agents/shiplane/shiplane.mjs', '.agents/shiplane/pre-push.mjs', '.agents/shiplane.lock', '.agents/shiplane/NOTES.md', '.githooks/pre-push']) assert.ok(init.includes(p), p);
  assert.ok(init.includes('.github/workflows/tug-events.yml'), 'the init PR leaves .github/ alone');
  const events = tree(`shiplane/events-v${VERSION}`);
  assert.ok(events.includes('.github/workflows/shiplane-events.yml') && !events.includes('.github/workflows/tug-events.yml'));
  assert.ok(events.includes('.agents/tug/tug.mjs'), 'the events PR changes only .github/ and the files naming the workflow');
  assert.match(prs[0].body, /- delete `\.agents\/tug\.lock`/);
  assert.match(prs[1].body, /tug-events\.yml/);
  assert.match(testGit(bare, ['show', `shiplane/init-v${VERSION}:.gitignore`]), /^!\.agents\/shiplane\/$/m);
});

/** A HOME under the temp dir, with ~/.claude and ~/.codex holding tug 1.1.0's user-level hooks and registry. */
function tugHome() {
  const home = assertInTmp(mkdtempSync(join(realpathSync(tmpdir()), 'shiplane-home-')));
  dirs.push(home);
  const env = { HOME: home };
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
  const tugCmd = name => `'/usr/bin/node' '/opt/batchship/bin/tug.mjs' guard --hook ${name}`;
  writeFileSync(join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'tug@tug': true }, model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }, { hooks: [{ type: 'command', command: tugCmd('claude'), timeout: 30 }] }], PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt' }] }] } }, null, 2));
  writeFileSync(join(home, '.codex/hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: tugCmd('codex'), timeout: 30 }] }] } }, null, 2));
  writeFileSync(join(home, '.codex/config.toml'), '[plugins."tug@tug"]\nenabled = true\n');
  mkdirSync(join(home, '.config/tug'), { recursive: true });
  writeFileSync(join(home, '.config/tug/repos'), '# tug upkeep: <root checkout> <ship branch> <owner/name>\n/r/one main acme/one\n/r/two staging acme/two\n');
  return { home, env };
}

test('setup in a temp HOME: tug\'s user-level guard hooks are replaced in place (merged, backed up), other hooks and keys kept', () => {
  const { home, env } = tugHome();
  const before = readFileSync(join(home, '.claude/settings.json'), 'utf8');
  const cmd = name => `'/usr/bin/node' '/opt/shiplane/bin/shiplane.mjs' guard --hook ${name}`;
  const lines = installGuardHooks({ env, root: null, command: cmd });
  assert.equal(lines.length, 2);
  assert.ok(lines.every(l => l.ok === true && /replaced tug's guard hook with shiplane's/.test(l.text)), JSON.stringify(lines));
  const claude = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8'));
  assert.equal(claude.model, 'opus');
  assert.deepEqual(claude.enabledPlugins, { 'tug@tug': true }, 'plugin settings are not setup\'s');
  assert.deepEqual(claude.hooks.PostToolUse, [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt' }] }]);
  assert.deepEqual(claude.hooks.Stop, [{ hooks: [{ type: 'command', command: 'say done' }] }, { hooks: [{ type: 'command', command: cmd('claude'), timeout: 30 }] }]);
  assert.equal(readFileSync(join(home, '.claude/settings.json.shiplane-backup'), 'utf8'), before);
  assert.equal(installedGuard(join(home, '.codex/hooks.json')), cmd('codex'));
  assert.ok(!isLegacyGuardCommand(installedGuard(join(home, '.codex/hooks.json'))));
  // Idempotent.
  assert.ok(installGuardHooks({ env, command: cmd }).every(l => /already in/.test(l.text)));
});

test('setup in a temp HOME: a repo with a project-level shiplane hook still gets tug\'s user-level hook replaced', () => {
  const { env } = tugHome();
  const root = tempRepo({ '.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR:-.}/.agents/shiplane/shiplane.mjs" guard --hook claude' }] }] } }) });
  dirs.push(root);
  const [claude] = installGuardHooks({ env, root, command: name => `shiplane guard --hook ${name}` });
  assert.match(claude.text, /replaced tug's guard hook/);
  assert.equal(installedGuard(harnesses(env)[0].path), 'shiplane guard --hook claude');
  // Once replaced, the project-level hook is enough again: nothing more is installed.
  assert.match(installGuardHooks({ env, root, command: name => `shiplane guard --hook ${name}` })[0].text, /project-level\); no user-level hook installed/);
});

test('registry in a temp HOME: setup moves ~/.config/tug/repos into shiplane\'s (merged), upkeep reads tug\'s until then', () => {
  const { home, env } = tugHome();
  const to = registryPath(env);
  assert.equal(to, join(home, '.config/shiplane/repos'));
  assert.deepEqual(upkeepEntries(env).map(e => e.root), ['/r/one', '/r/two'], 'upkeep still finds tug\'s repos');
  writeRegistry([{ root: '/r/two', base: 'main', slug: 'acme/two' }], to);
  const moved = moveLegacyRegistry({ env, to, readRegistry, writeRegistry });
  assert.equal(moved.moved, 2);
  assert.deepEqual(readRegistry(to), [{ root: '/r/two', base: 'main', slug: 'acme/two' }, { root: '/r/one', base: 'main', slug: 'acme/one' }], 'shiplane\'s own entry wins');
  assert.ok(!existsSync(legacyRegistryPath(env)) && !existsSync(join(home, '.config/tug')));
  assert.equal(moveLegacyRegistry({ env, to, readRegistry, writeRegistry }), null);
  assert.equal(legacyRegistryPath({}), null, 'no HOME: no path is guessed');
});

test('doctor: tug leftovers in a temp repo and a temp HOME are reported, and none once migrated', () => {
  const { home, env } = tugHome();
  const files = tugRepoFiles();
  const root = tempRepo(files);
  dirs.push(root);
  const left = tugLeftovers({ root, env, harnesses: harnesses(env) });
  const text = left.map(l => l.text).join('\n');
  for (const want of ['.agents/tug/ exists', '.agents/tug.lock exists', 'tug-events.yml exists', 'AGENTS.md has a <!-- tug:start --> block', 'lefthook.yml calls .agents/tug/', '.claude/settings.json runs tug\'s guard', '.gitignore has rules for .agents/tug', `${join(home, '.claude/settings.json')} runs tug's guard`, `${join(home, '.codex/hooks.json')} runs tug's guard`, 'has the tug@tug plugin', `${join(home, '.config/tug/repos')} exists`]) assert.ok(text.includes(want), `${want}\n---\n${text}`);
  const clean = tempRepo({ 'README.md': 'tugboats are fine\n', '.gitignore': '# was .agents/tug/\n' });
  dirs.push(clean);
  const cleanHome = assertInTmp(mkdtempSync(join(realpathSync(tmpdir()), 'shiplane-home-')));
  dirs.push(cleanHome);
  assert.deepEqual(tugLeftovers({ root: clean, env: { HOME: cleanHome }, harnesses: harnesses({ HOME: cleanHome }) }), []);
});

test('doctor\'s probe is answered by shiplane\'s guard under either name, and bin/tug.mjs forwards to shiplane', async () => {
  const { spawnSync } = await import('node:child_process');
  const cwd = assertInTmp(mkdtempSync(join(realpathSync(tmpdir()), 'shiplane-probe-')));
  dirs.push(cwd);
  for (const bin of ['shiplane.mjs', 'tug.mjs']) {
    const r = spawnSync(process.execPath, [new URL(`../bin/${bin}`, import.meta.url).pathname, 'guard', '--hook', 'claude'], { cwd, input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'p', cwd, tug_probe: true }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /"shiplane_probe":"ok"/, bin);
  }
});
