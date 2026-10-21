#!/usr/bin/env node
// Run in the target repo: node <batchship>/scripts/init.mjs  (never overwrites existing files)
import { existsSync, mkdirSync, copyFileSync, appendFileSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { detect, ciWorkflows } from './detect.mjs';
import { DEFAULTS } from './config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const put = (from, to) => {
  if (existsSync(to)) return console.log(`skip   ${to} (exists)`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(root, from), to);
  console.log(`create ${to}`);
};

// runtime copy: agents without the plugin can still run the check
for (const f of ['config.mjs', 'batch-check.mjs', 'batch-guard.mjs', 'detect.mjs']) put(`scripts/${f}`, `.batchship/${f}`);
writeFileSync('.batchship/package.json', '{"type":"module"}\n');

if (!existsSync('.ship.json')) {
  const checks = detect();
  writeFileSync('.ship.json', JSON.stringify({ ...DEFAULTS, checks }, null, 2) + '\n');
  console.log(`create .ship.json (${checks.length} draft checks)`);
  if (!checks.length) console.log('  none detected: add checks by hand');
} else console.log('skip   .ship.json (exists)');
put('templates/agents-hooks.json', '.agents/hooks.json'); // Antigravity workspace hook
put('templates/BATCH.md', 'BATCH.md');
put('templates/pull_request_template.md', '.github/pull_request_template.md');

const rule = readFileSync(join(root, 'templates/AGENTS-snippet.md'), 'utf8');
const agents = existsSync('AGENTS.md') ? readFileSync('AGENTS.md', 'utf8') : '';
if (!agents.includes('BATCH.md')) { appendFileSync('AGENTS.md', (agents ? '\n' : '') + rule); console.log('update AGENTS.md'); }

const hook = execSync('git rev-parse --git-path hooks/pre-push', { encoding: 'utf8' }).trim();
if (!existsSync(hook)) {
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\nwhile read l ls r rs; do case "$r" in refs/heads/main|refs/heads/master) echo "batchship: no direct push to the protected branch; use ship/NAME + PR" >&2; exit 1;; esac; done\n`);
  chmodSync(hook, 0o755);
  console.log(`create ${hook}`);
}

console.log('\nDraft checks are guesses. Review .ship.json: keep only fast checks that match your CI.');
if (ciWorkflows().length) console.log(`CI workflows found: ${ciWorkflows().join(', ')}. Compare commands against them.`);
console.log('Ask your agent: /ship-batch setup   (or edit .ship.json by hand). Guard is in warn mode.');
