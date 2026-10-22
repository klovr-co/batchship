#!/usr/bin/env node
// Run in the target repo: node <batchship>/scripts/init.mjs [--protected staging] [--manual main]  (never overwrites existing files)
// --protected: the live branch where batches land (default main). --manual: comma list of branches only a human touches (agents may not push or PR to them).
// --update: in a repo already set up, refresh the .batchship/ runtime, BATCH.md and the batch section of AGENTS.md (keeps .ship.json).
import { readdirSync, existsSync, mkdirSync, copyFileSync, appendFileSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { detect, ciWorkflows } from './detect.mjs';
import { DEFAULTS } from './config.mjs';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const update = process.argv.includes('--update');
const put = (from, to, refresh = false) => {
  if (existsSync(to) && !(update && refresh)) return console.log(`skip   ${to} (exists)`);
  const verb = existsSync(to) ? 'update' : 'create';
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(root, from), to);
  console.log(`${verb} ${to}`);
};

// runtime copy: agents without the plugin can still run the check
// branch-check.mjs serves the GitHub workflow only: --update refreshes it where the repo has it, never adds it.
for (const f of ['config.mjs', 'lib.mjs', 'batch-check.mjs', 'batch-guard.mjs', 'detect.mjs', 'branch-check.mjs', 'pre-push.mjs', 'triage.mjs', 'fix.mjs', 'ship.mjs', 'review.mjs'])
  if (!(update && f === 'branch-check.mjs' && !existsSync(`.batchship/${f}`))) put(`scripts/${f}`, `.batchship/${f}`, true);
writeFileSync('.batchship/package.json', '{"type":"module"}\n');
writeFileSync('.batchship/VERSION', JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8')).version + '\n'); // the guard compares it with the plugin's

if (!existsSync('.ship.json')) {
  const checks = detect();
  writeFileSync('.ship.json', JSON.stringify({ ...DEFAULTS, protectedBranch: arg('protected') || DEFAULTS.protectedBranch, manualBranches: (arg('manual') || '').split(',').filter(Boolean), checks }, null, 2) + '\n');
  console.log(`create .ship.json (${checks.length} draft checks)`);
  if (!checks.length) console.log('  none detected: add checks by hand');
} else console.log('skip   .ship.json (exists)');
put('templates/agents-hooks.json', '.agents/hooks.json'); // Antigravity workspace hook
put('templates/codex-hooks.json', '.codex/hooks.json'); // Codex repo hook
const wf = '.github/workflows/batch-branch-check.yml';
if (update) console.log(`skip   ${wf} (--update leaves workflows alone)`);
else if (!existsSync(wf)) {
  const cfg = JSON.parse(readFileSync('.ship.json', 'utf8'));
  const branches = JSON.stringify([cfg.protectedBranch]);
  mkdirSync(dirname(wf), { recursive: true });
  // Repos that require SHA-pinned actions reject `actions/checkout@v4` (the run dies with startup_failure): reuse the repo's own pinned line.
  const pinned = readdirSync('.github/workflows').map((f) => readFileSync(join('.github/workflows', f), 'utf8').match(/actions\/checkout@[0-9a-f]{40}(?:\s+#\s*\S+)?/)?.[0]).find(Boolean);
  writeFileSync(wf, readFileSync(join(root, 'templates/batch-branch-check.yml'), 'utf8').replace('__BRANCHES__', branches).replace('__CHECKOUT__', pinned || 'actions/checkout@v4'));
  if (!pinned) console.log('  note: using actions/checkout@v4; if the repo requires SHA-pinned actions, pin it by hand');
  console.log(`create ${wf}`);
} else console.log(`skip   ${wf} (exists)`);
put('templates/BATCH.md', 'BATCH.md', true);
put('templates/pull_request_template.md', '.github/pull_request_template.md');

// The batch section sits between markers so --update can replace it. Older installs had an unmarked "## Batch flow" section.
const rule = readFileSync(join(root, 'templates/AGENTS-snippet.md'), 'utf8').trim();
const agents = existsSync('AGENTS.md') ? readFileSync('AGENTS.md', 'utf8') : '';
const section = /<!-- batchship:start -->[\s\S]*?<!-- batchship:end -->\n?|## Batch flow\n[\s\S]*?(?=\n## |$)/;
if (section.test(agents)) {
  if (update) { writeFileSync('AGENTS.md', agents.replace(section, rule + '\n')); console.log('update AGENTS.md (batch section)'); }
} else { appendFileSync('AGENTS.md', (agents ? '\n' : '') + rule + '\n'); console.log('update AGENTS.md'); }
// Claude Code reads CLAUDE.md, not AGENTS.md.
const claude = existsSync('CLAUDE.md') ? readFileSync('CLAUDE.md', 'utf8') : '';
if (!/@AGENTS\.md/.test(claude)) { appendFileSync('CLAUDE.md', (claude ? '\n' : '') + '@AGENTS.md\n'); console.log('update CLAUDE.md (imports AGENTS.md)'); }

const hook = execSync('git rev-parse --git-path hooks/pre-push', { encoding: 'utf8' }).trim();
if (!existsSync(hook)) {
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\n[ -f .batchship/pre-push.mjs ] || exit 0\nexec node .batchship/pre-push.mjs\n');
  chmodSync(hook, 0o755);
  console.log(`create ${hook}`);
}

console.log('\nDraft checks are guesses. Review .ship.json: keep only fast checks that match your CI.');
if (ciWorkflows().length) console.log(`CI workflows found: ${ciWorkflows().join(', ')}. Compare commands against them.`);
console.log('Ask your agent: /ship-batch setup   (or edit .ship.json by hand). Guard is in warn mode.');
