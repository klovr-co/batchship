import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';

export const DEFAULTS = {
  protectedBranch: 'main',   // the live/integration branch: batches land here
  manualBranches: [],        // branches only a human touches (e.g. ['main'] when staging is the live branch): agents may not push or open PRs to them
  batchPrefixes: ['ship/'],
  hotfixPrefixes: ['hotfix/'],
  guardMode: 'warn', // 'warn' | 'block'
  checks: [],        // { name, cmd, cwd?, paths?: string[] (prefixes), quick?: boolean, shipOnly?: boolean (skipped per fix, run once when the batch ships) }
  batchPer: 'day',    // 'day': every thread's fixes join today's batch ship/day-<date>; 'session': each agent session (thread) gets its own batch ship/<first-fix>-<date>, and ship.mjs ships that one
  batchMaxAgeDays: 0, // days a batch takes new fixes: 0 = only the day it is dated (one batch per day)
  batchMaxFiles: 40,  // a batch with this many changed files (lockfiles aside) is full: new work goes to a new batch; 0 = no cap
  soloPaths: [],      // path prefixes (e.g. ['.github/']) whose changes must ship in a batch of their own
  setup: null,        // command run in a new batch worktree (default: install with the detected package manager)
  mergeVia: 'auto',   // who merges a batch PR into the live branch: 'gh' (ship.mjs), 'mergify' (the Mergify queue), 'auto' = mergify when the repo has .mergify.yml
  review: {
    reviewers: ['same'], // 'same' (the agent's own harness), 'claude', 'codex', 'agy', each optionally ':model'; or { name, cmd }. [] turns review off
    riskyReviewers: null, // reviewers for a risky change (touches soloPaths or riskyPaths, or more than riskyLines changed lines); null = reviewers
    riskyPaths: [],       // extra path prefixes that make a change risky, on top of soloPaths
    riskyLines: 400,      // changed lines (added + deleted) above which a change is risky; 0 = size never makes it risky
    rounds: 2,           // review runs per batch before it goes back to the human
    ciRounds: 3,         // red CI runs on a batch PR before ship.mjs stops trying and hands it to the human
    batchRepairRounds: 1, // times a blocker from the whole-batch review goes to a repair fix before the batch PR waits for the human
    humanPaths: [],      // path prefixes: a batch that touches one stops at the draft PR for the human, whatever review.after says
    after: 'merge',      // 'merge': when the batch ships, ship.mjs marks the batch PR ready, waits for CI and merges it (each fix already passed its review). 'human': stop at the draft PR
    timeoutMinutes: 20,
    queueTimeoutMinutes: 120, // with Mergify: how long ship.mjs waits for the queue to merge or drop the batch PR
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
