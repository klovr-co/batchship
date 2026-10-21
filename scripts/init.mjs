#!/usr/bin/env node
// Run in a repo: node <plugin>/scripts/init.mjs  (never overwrites existing files)
import { existsSync, mkdirSync, copyFileSync, appendFileSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const put = (from, to) => {
  if (existsSync(to)) return console.log(`skip   ${to} (exists)`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(join(root, 'templates', from), to);
  console.log(`create ${to}`);
};
put('ship.json', '.ship.json');
put('BATCH.md', 'BATCH.md');
put('pull_request_template.md', '.github/pull_request_template.md');

const rule = readFileSync(join(root, 'templates/AGENTS-snippet.md'), 'utf8');
const agents = existsSync('AGENTS.md') ? readFileSync('AGENTS.md', 'utf8') : '';
if (!agents.includes('BATCH.md')) { appendFileSync('AGENTS.md', (agents ? '\n' : '') + rule); console.log('update AGENTS.md'); }

// git-level guard: works for any agent or human, not only Claude Code
const hook = execSync('git rev-parse --git-path hooks/pre-push', { encoding: 'utf8' }).trim();
if (!existsSync(hook)) {
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\nwhile read l ls r rs; do case "$r" in refs/heads/main) echo "batchship: no direct push to main; use ship/NAME + PR" >&2; exit 1;; esac; done\n`);
  chmodSync(hook, 0o755);
  console.log(`create ${hook}`);
}
console.log('\nNext: edit .ship.json checks to match your CI jobs.');
