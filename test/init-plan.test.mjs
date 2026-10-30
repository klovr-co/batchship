// tug init's plan for 1.1.1: superseded AGENTS sections, config guesses, the events header, hook wiring, the block.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../lib/config.mjs';
import { detectHookManager, GATE_COMMAND, GATE_HEAD_COMMAND, hookInstallStep, mergeLefthookPrePush, REPO_HOOK, wireHook } from '../lib/hooks.mjs';
import { deployCandidates, planInit, runsOnPushTo } from '../lib/init.mjs';
import { eventsHeader, hookLine, needsMeUrl, removeSupersededSections, renderAgentsBlock, renderEvents, template } from '../lib/render.mjs';
import { parseYaml } from '../lib/yaml.mjs';
import { memReader } from './helpers.mjs';

const byPath = plan => Object.fromEntries(plan.files.map(f => [f.path, f]));

test('#9.3 superseded AGENTS sections are removed in the init PR and listed; supersededSections: [] keeps them', () => {
  const agents = [
    '# Rules', '', 'intro', '',
    '## Ship target', 'staging, unless the owner says release', '',
    '### Detail', 'more', '',
    '## Convex', 'keep me', '',
    '```md', '## Merging', '```', '',
    '## Merging: the merge queue', 'label queue', '',
    '## Done means checked', 'screenshots', '',
  ].join('\n');
  const plan = planInit({ reader: memReader({ 'AGENTS.md': agents }), defaultBranch: 'main' });
  const out = byPath(plan)['AGENTS.md'].content;
  assert.deepEqual(plan.removedSections, ['Ship target', 'Merging: the merge queue', 'Done means checked']);
  assert.ok(!/## Ship target|### Detail|label queue|## Done means checked/.test(out));
  assert.match(out, /^# Rules\n\nintro\n\n## Convex\nkeep me\n\n```md\n## Merging\n```\n\n<!-- tug:start/, 'the rest is kept, code fences too');
  assert.match(byPath(plan)['AGENTS.md'].why, /removed hand-written sections the block replaces: "Ship target", "Merging: the merge queue", "Done means checked"/);
  assert.ok(plan.notes.some(n => /AGENTS\.md: removed "Ship target"/.test(n)));
  const kept = planInit({ reader: memReader({ 'AGENTS.md': agents, '.agents/config.yml': 'supersededSections: []\n' }), defaultBranch: 'main' });
  assert.deepEqual(kept.removedSections, []);
  assert.ok(byPath(kept)['AGENTS.md'].content.startsWith(agents.replace(/\n+$/, '')));
  // Custom list; a heading inside the tug block is never touched; CRLF kept.
  const crlf = '# A\r\n\r\n## Old shipping\r\nx\r\n\r\n## Keep\r\ny\r\n';
  const r = removeSupersededSections(crlf, ['old shipping']);
  assert.deepEqual(r.removed, ['Old shipping']);
  assert.equal(r.text, '# A\r\n\r\n## Keep\r\ny\r\n');
  assert.deepEqual(removeSupersededSections('<!-- tug:start v1 -->\n## Merging\n<!-- tug:end -->\n', ['Merging']).removed, []);
  // Only `##` sections: a "### Merging" under another topic, or a "# Merging" document, is the repo's own.
  const nested = '## Database migrations\nx\n\n### Merging\nkeep\n';
  assert.deepEqual(removeSupersededSections(nested, ['Merging']).removed, []);
  assert.deepEqual(removeSupersededSections('# Merging\n\n## Setup\nkeep\n', ['Merging']).removed, []);
});

test('#9.4 workflowHeader lines stay at the top of tug-events.yml; existing "# Dry run:"/"# Revert:" lines survive a re-render', () => {
  const config = parseConfig('workflowHeader: ["Dry run: comments only", "# CI budget: 1 slim job"]\n');
  const first = renderEvents(config, []);
  const lines = first.split('\n');
  assert.match(lines[0], /^# Managed by tug/);
  assert.deepEqual(lines.slice(1, 3), ['# Dry run: comments only', '# CI budget: 1 slim job']);
  assert.equal(renderEvents(config, [], undefined, { existing: first }), first, 'stable: doctor compares the same way');
  // 3ven's file today: hand-added lines under the managed line, no workflowHeader in the config.
  const threeVen = first.split('\n').filter((l, i) => i === 0 || !/^# (Dry run|CI budget)/.test(l));
  threeVen.splice(1, 0, '# Dry run: it only comments.', '# Revert: gh workflow disable tug-events.yml');
  const rerendered = renderEvents(parseConfig(null), [], undefined, { existing: threeVen.join('\n') });
  assert.deepEqual(rerendered.split('\n').slice(1, 3), ['# Dry run: it only comments.', '# Revert: gh workflow disable tug-events.yml']);
  assert.deepEqual(eventsHeader(parseConfig(null), 'name: x\n# Dry run: not in the header block\n'), []);
  const older = threeVen.join('\n').replace(/^# Managed by tug [\d.]+/, '# Managed by tug 1.1.0');
  const plan = planInit({ reader: memReader({ '.github/workflows/tug-events.yml': older }), defaultBranch: 'main' });
  assert.match(plan.ciFiles[0].content, /^# Managed by tug [\d.]+ .*\n# Dry run: it only comments\.\n# Revert: gh workflow disable/);
  assert.throws(() => parseConfig('workflowHeader: [1]\n'), /one line of text/);
});

test('#9.5 config guesses: mergeMethod from .mergify.yml, deploys that run on a push to the ship branch, liveUrl noted', () => {
  const wf = {
    '.github/workflows/deploy.yml': 'name: Deploy\non:\n  workflow_dispatch:\n    inputs:\n      target:\n        type: choice\n        options: [staging]\n  push:\n    branches: [main]\njobs:\n  a:\n    steps:\n      - run: |\n          echo hi\n',
    '.github/workflows/release-tags.yml': 'on:\n  push:\n    tags: ["v*"]\n',
    '.github/workflows/deploy-web.yml': 'on:\n  workflow_run:\n    workflows: [CI]\n    types: [completed]\n    branches: [main]\n',
    '.github/workflows/deploy-staging.yml': 'on:\n  push:\n    branches: [staging]\n',
    '.github/workflows/release.yml': 'on: workflow_dispatch\n',
    '.github/workflows/ci.yml': 'on: push\n',
  };
  assert.deepEqual(deployCandidates(memReader(wf), 'main').sort(), ['deploy-web.yml', 'deploy.yml']);
  assert.equal(runsOnPushTo('on: [push, pull_request]\n', 'main'), true);
  assert.equal(runsOnPushTo("on:\n  push:\n    branches: ['release/**']\n", 'release/1.2'), true);
  assert.equal(runsOnPushTo('on:\n  push:\n    branches-ignore: [main]\n', 'main'), false);
  const mergify = '# own\nqueue_rules:\n  - name: default\n    queue_conditions:\n      - -label = hold\n      - -label = needs-owner\n    merge_method: merge\n';
  const plan = planInit({ reader: memReader({ ...wf, '.mergify.yml': mergify }), defaultBranch: 'main' });
  const config = parseConfig(byPath(plan)['.agents/config.yml'].content);
  assert.equal(config.mergeMethod, 'merge');
  assert.deepEqual(config.deployWorkflows.sort(), ['deploy-web.yml', 'deploy.yml']);
  assert.equal(config.liveUrl, null);
  assert.ok(plan.notes.some(n => /guessed mergeMethod merge \(from \.mergify\.yml\)/.test(n)));
  assert.ok(plan.notes.some(n => /liveUrl is left empty: tug cannot guess/.test(n)));
  // An existing config is never changed, but a mismatch and missed deploys are noted.
  const existing = planInit({ reader: memReader({ ...wf, '.mergify.yml': mergify, '.agents/config.yml': 'mergeMethod: squash\nliveUrl: https://x.example\n' }), defaultBranch: 'main' });
  assert.ok(existing.notes.some(n => /mergeMethod is squash .* but \.mergify\.yml merges with merge/.test(n)));
  assert.ok(existing.notes.some(n => /deployWorkflows is empty, but deploy\.yml, deploy-web\.yml|deployWorkflows is empty, but deploy-web\.yml, deploy\.yml/.test(n)));
  assert.ok(!existing.notes.some(n => /liveUrl is left empty/.test(n)));
});

test('A.3 lefthook: the gate is merged into an existing pre-push section (commands, jobs, or neither)', () => {
  const commands = 'pre-push:\n  parallel: true\n  commands:\n    lint:\n      run: eslint .\npost-merge:\n  commands:\n    x:\n      run: y\n';
  const c = parseYaml(mergeLefthookPrePush(commands, parseYaml));
  assert.deepEqual(c['pre-push'].commands, { lint: { run: 'eslint .' }, tug: { run: GATE_COMMAND, use_stdin: true } });
  assert.deepEqual(c['post-merge'], { commands: { x: { run: 'y' } } });
  // aldrent: a jobs list whose job already takes git's stdin (lefthook gives it to one job only): the gate checks HEAD.
  const aldrent = 'pre-commit:\n  jobs:\n    - run: bun x biome format --write {staged_files}\n\n# Before a push\npre-push:\n  jobs:\n    - name: pre-push gate\n      run: PRE_PUSH_STDIN=1 node scripts/pre-push-check.mjs\n      # stdin\n      use_stdin: true\n';
  const merged = mergeLefthookPrePush(aldrent, parseYaml);
  assert.ok(merged.startsWith(aldrent.replace(/\n$/, '')), 'the existing lines are untouched');
  const jobs = parseYaml(merged.slice(merged.indexOf('pre-push:')))['pre-push'].jobs;
  assert.deepEqual(jobs[1], { name: 'tug pre-push gate', run: GATE_HEAD_COMMAND });
  const neither = parseYaml(mergeLefthookPrePush('pre-push:\n  parallel: true\n', parseYaml));
  assert.deepEqual(neither['pre-push'], { parallel: true, commands: { tug: { run: GATE_COMMAND, use_stdin: true } } });
  assert.equal(mergeLefthookPrePush('pre-push:\n  scripts:\n    a.sh:\n      runner: bash\n', parseYaml), null, 'scripts: left for a person');
  assert.equal(mergeLefthookPrePush('pre-push: {}\n', parseYaml), null);
  // Installed automatically? lefthook via prepare; aldrent's bunfig ignoreScripts means not.
  const reader = memReader({ 'lefthook.yml': aldrent, 'package.json': '{"scripts":{"prepare":"lefthook install || true"}}' });
  assert.equal(hookInstallStep(detectHookManager(reader), reader).auto, true);
  const ignore = memReader({ 'lefthook.yml': aldrent, 'package.json': '{"scripts":{"prepare":"lefthook install"}}', 'bunfig.toml': '[install]\nignoreScripts = true\n' });
  assert.match(hookInstallStep(detectHookManager(ignore), ignore).why, /skips scripts/);
  const plan = planInit({ reader: ignore, defaultBranch: 'main' });
  assert.ok(byPath(plan)['lefthook.yml']);
  assert.ok(plan.notes.some(n => /Pre-push hook: the install step skips scripts/.test(n)));
});

test('A.3 husky: the gate is appended to an existing .husky/pre-push; one that exits early is left with a note', () => {
  const tpl = template('githooks/pre-push');
  const own = memReader({ '.husky/pre-push': 'npm test\n' });
  const w = wireHook(detectHookManager(own), own, { template: tpl });
  assert.equal(w.content, `npm test\n# tug pre-push gate (reads what is left of git's stdin; with none it checks HEAD).\n${GATE_COMMAND} "$@"\n`);
  const early = memReader({ '.husky/pre-push': 'exec npm test\n' });
  assert.match(wireHook(detectHookManager(early), early, { template: tpl }).manual, /ends early/);
});

test('A.3 .githooks: the repo\'s own pre-push is kept and run first; a re-run keeps calling it; a checkCommand duplicate is dropped', () => {
  const threeVen = '#!/bin/sh\nexec node scripts/check-before-push.mjs --hook "$@"\n';
  const plan = planInit({ reader: memReader({ '.githooks/pre-push': threeVen }), defaultBranch: 'main' });
  const files = byPath(plan);
  assert.equal(files[REPO_HOOK].content, threeVen);
  assert.equal(files[REPO_HOOK].mode, 0o755);
  assert.match(files['.githooks/pre-push'].content, /\| \.\/\.githooks\/pre-push\.repo "\$@" \|\| exit 1\nif \[ -f \.agents\/tug\/pre-push\.mjs \]/);
  assert.ok(JSON.parse(files['.agents/tug.lock'].content).files.includes(REPO_HOOK));
  const tree = Object.fromEntries(plan.files.map(f => [f.path, f.content]));
  const again = planInit({ reader: memReader(tree), defaultBranch: 'main' });
  assert.ok(!byPath(again)['.githooks/pre-push'] && !byPath(again)[REPO_HOOK], 'stable on a re-run');
  const dup = planInit({ reader: memReader({ '.githooks/pre-push': threeVen, '.agents/config.yml': 'checkCommand: node scripts/check-before-push.mjs --hook\n' }), defaultBranch: 'main' });
  assert.ok(!byPath(dup)[REPO_HOOK]);
  assert.ok(dup.notes.some(n => /it ran checkCommand/.test(n)));
  // A hook that does more than checkCommand is kept, so its other checks keep running.
  const more = planInit({ reader: memReader({ '.githooks/pre-push': '#!/bin/sh\nnode scripts/check-before-push.mjs --hook "$@" || exit 1\n./scripts/secrets-scan.sh\n', '.agents/config.yml': 'checkCommand: node scripts/check-before-push.mjs --hook\n' }), defaultBranch: 'main' });
  assert.ok(byPath(more)[REPO_HOOK]);
  // --force replaces a non-tug hook but keeps calling an existing .githooks/pre-push.repo.
  const forced = planInit({ reader: memReader({ ...tree, '.githooks/pre-push': '#!/bin/sh\necho mine\n' }), defaultBranch: 'main', force: true });
  assert.match(byPath(forced)['.githooks/pre-push'].content, /\.\/\.githooks\/pre-push\.repo/);
});

test('A.3/A.4 the AGENTS block: the hook line first, the needs-me browser link with the org, ship through .agents/tug', () => {
  const config = parseConfig(null);
  const block = renderAgentsBlock(config, '9.9.9', { org: 'klovr-co', hook: { manager: 'githooks' } });
  const lines = block.split('\n');
  assert.match(lines[2], /^First: .*run `git config core\.hooksPath \.githooks`\.$/);
  assert.match(block, /in a browser https:\/\/github\.com\/pulls\?q=is:open\+org:klovr-co\+label:needs-owner,hold/);
  assert.equal(needsMeUrl(null), 'https://github.com/pulls?q=is:open+org:<org>+label:needs-owner,hold');
  assert.match(hookLine({ manager: 'lefthook', pm: 'bun' }), /`bunx lefthook install`/);
  assert.match(block, /`node \.agents\/tug\/tug\.mjs ship <pr> --background`/);
  assert.match(block, /never with a PR watch alone \(T3's PR watch ends at merge without waking you\)/);
  const plan = planInit({ reader: memReader({ 'lefthook.yml': 'pre-commit: {}\n', 'bun.lock': '' }), defaultBranch: 'main', org: 'acme' });
  const agents = byPath(plan)['AGENTS.md'].content;
  assert.match(agents, /runs through lefthook .*`bunx lefthook install`/);
  assert.match(agents, /org:acme\+/);
});

test('the ship skill says the same: vendored command, background wait, never a PR watch alone', async () => {
  const { readFileSync } = await import('node:fs');
  const skill = readFileSync(new URL('../skills/ship/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /node \.agents\/tug\/tug\.mjs ship/);
  assert.match(skill, /wait with `ship --background`, never with a PR watch alone \(T3's PR watch ends at merge without waking you\)/i);
});
