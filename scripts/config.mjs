import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';

export const DEFAULTS = {
  protectedBranch: 'main',   // the live/integration branch: batches land here
  manualBranches: [],        // branches only a human touches (e.g. ['main'] when staging is the live branch): agents may not push or open PRs to them
  batchPrefixes: ['ship/'],
  hotfixPrefixes: ['hotfix/'],
  guardMode: 'warn', // 'warn' | 'block'
  checks: [],        // { name, cmd, cwd?, paths?: string[] (prefixes), quick?: boolean }
  batchMaxAgeDays: 0, // days a batch takes new fixes: 0 = only the day it is dated (one batch per day)
  batchMaxFiles: 40,  // a batch with this many changed files (lockfiles aside) is full: new work goes to a new batch; 0 = no cap
  soloPaths: [],      // path prefixes (e.g. ['.github/']) whose changes must ship in a batch of their own
  setup: null,        // command run in a new batch worktree (default: install with the detected package manager)
  review: {
    reviewers: ['same'], // 'same' (the agent's own harness), 'claude', 'codex', 'agy', each optionally ':model'; or { name, cmd }. [] turns review off
    rounds: 2,           // review runs per batch before it goes back to the human
    after: 'merge',      // 'merge': when the batch ships, ship.mjs marks the batch PR ready, waits for CI and merges it (each fix already passed its review). 'human': stop at the draft PR
    timeoutMinutes: 20,
    focus: '',           // extra review instructions for every batch
  },
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
  if (!existsSync(file)) return { ...DEFAULTS, review: { ...DEFAULTS.review } };
  const own = JSON.parse(readFileSync(file, 'utf8'));
  return { ...DEFAULTS, ...own, review: { ...DEFAULTS.review, ...own.review } };
}

// Review settings and guardMode come from the live branch's .ship.json, so a batch cannot switch its own review or guard off.
// Falls back to the local file when the live branch has none yet (the batch that installs batchship).
export function withLivePolicy(dir, config) {
  let live;
  try { live = JSON.parse(execSync(`git show origin/${config.protectedBranch}:.ship.json`, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return config; }
  return { ...config, guardMode: live.guardMode ?? DEFAULTS.guardMode, review: { ...DEFAULTS.review, ...live.review } };
}
