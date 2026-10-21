import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULTS = {
  protectedBranch: 'main',   // the live/integration branch: batches land here
  manualBranches: [],        // branches only a human touches (e.g. ['main'] when staging is the live branch): agents may not push or open PRs to them
  batchPrefixes: ['ship/'],
  hotfixPrefixes: ['hotfix/'],
  guardMode: 'warn', // 'warn' | 'block'
  checks: [],        // { name, cmd, cwd?, paths?: string[] (prefixes), quick?: boolean }
  batchMaxAgeDays: 7, // batches dated older than this are never joined
  soloPaths: [],      // path prefixes (e.g. ['.github/']) whose changes must ship in a batch of their own
  setup: null,        // command run in a new batch worktree (default: install with the detected package manager)
};

// Walks up from dir to the repo root holding .ship.json; null when the repo does not use batchship.
export function findRoot(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.ship.json'))) return d;
    if (existsSync(join(d, '.git')) || dirname(d) === d) return null;
  }
}

export function loadConfig(dir = process.cwd()) {
  const file = join(dir, '.ship.json');
  if (!existsSync(file)) return { ...DEFAULTS };
  return { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) };
}
