#!/usr/bin/env node
// Branch triage for agents: which batch does this change go in, and where is its worktree?
//   triage.mjs --area <area> [--apply] [--json]   decide (and with --apply, create or reuse the worktree)
//   triage.mjs list                               open batches, stale ones flagged
// One batch = one branch ship/<area>-<YYYYMMDD> = one worktree. Join the newest draft batch for the area
// dated within batchMaxAgeDays (default 7); otherwise start a new one. CI changes always start a new one.
import { execSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';

const DAY = 86_400_000;
// Local dates, so a batch is named after the day you are working in, not the UTC day.
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
export const ageDays = (created, today) => Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - created) / DAY);
export const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ship/<area>-<YYYYMMDD>[-<n>]; anything else is not a triage batch.
export function parseBatch(name) {
  const m = name.match(/^ship\/(.+?)-(\d{4})(\d\d)(\d\d)(?:-\d+)?$/);
  return m && { name, area: m[1], created: new Date(+m[2], +m[3] - 1, +m[4]).getTime() };
}

// batches: [{ name, area, created, state: 'open' | 'frozen' | 'done' }]
export function decide({ batches, area, today, maxAgeDays = 7 }) {
  const open = batches.filter((b) => b.state === 'open');
  const stale = open.filter((b) => ageDays(b.created, today) > maxAgeDays).map((b) => b.name);
  const join = area !== 'ci' && open
    .filter((b) => b.area === area && ageDays(b.created, today) <= maxAgeDays)
    .sort((x, y) => y.created - x.created)[0];
  if (join) return { action: 'join', batch: join.name, stale };
  const taken = new Set(batches.map((b) => b.name));
  let batch = `ship/${area}-${ymd(today)}`;
  for (let i = 2; taken.has(batch); i++) batch = `ship/${area}-${ymd(today)}-${i}`;
  return { action: 'new', batch, stale };
}

const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const trySh = (cmd, cwd) => { try { return sh(cmd, cwd); } catch { return ''; } };

function worktrees(cwd) {
  const map = {};
  let path;
  for (const line of trySh('git worktree list --porcelain', cwd).split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    if (line.startsWith('branch refs/heads/')) map[line.slice(18)] = path;
  }
  return map;
}

// State comes from the PR: merged/closed = done, ready = frozen, draft or no PR = open.
export function listBatches(cwd) {
  trySh('git fetch -q --prune origin', cwd);
  const names = new Set(trySh("git for-each-ref --format='%(refname:short)' refs/remotes/origin/ship/ refs/heads/ship/", cwd)
    .split('\n').filter(Boolean).map((r) => r.replace(/^origin\//, '')));
  const prs = {};
  try { for (const p of JSON.parse(trySh('gh pr list --state all --limit 200 --json headRefName,state,isDraft', cwd) || '[]')) prs[p.headRefName] ??= p; } catch {}
  const wts = worktrees(cwd);
  return [...names].map(parseBatch).filter(Boolean).map((b) => {
    const p = prs[b.name];
    return { ...b, state: !p ? 'open' : p.state !== 'OPEN' ? 'done' : p.isDraft ? 'open' : 'frozen', worktree: wts[b.name] || null };
  });
}

export function apply(cwd, { batch, action }, live) {
  const common = resolve(cwd, sh('git rev-parse --git-common-dir', cwd));
  const repo = dirname(common);
  const existing = worktrees(cwd)[batch];
  if (existing) { trySh('git pull -q --ff-only', existing); return existing; }
  const path = join(dirname(repo), '.batchship-wt', basename(repo), batch.replaceAll('/', '__'));
  if (action === 'new') sh(`git branch ${batch} origin/${live}`, cwd);
  else if (!trySh(`git rev-parse --verify -q refs/heads/${batch}`, cwd)) sh(`git branch --track ${batch} origin/${batch}`, cwd);
  sh(`git worktree add -q "${path}" ${batch}`, cwd);
  if (action === 'new') sh(`git push -q -u origin ${batch}`, path); // free: no workflow runs on ship/*
  return path;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const json = args.includes('--json');
  try {
    const cwd = sh('git rev-parse --show-toplevel');
    const config = loadConfig(cwd);
    const maxAgeDays = config.batchMaxAgeDays ?? 7;
    const today = new Date();
    const batches = listBatches(cwd);
    if (args[0] === 'list') {
      const rows = batches.filter((b) => b.state !== 'done').sort((a, b) => b.created - a.created).map((b) => {
        const age = ageDays(b.created, today);
        return `${b.name}\t${age ? `${age}d` : 'today'}\t${b.state}${age > maxAgeDays && b.state === 'open' ? ' STALE: close or abandon' : ''}\t${b.worktree || '-'}`;
      });
      console.log(json ? JSON.stringify(batches, null, 2) : rows.join('\n') || 'no open batches');
    } else {
      const area = slugify(opt('area'));
      if (!area) throw new Error('pass --area <name>: a short name for the part of the product this change touches (billing, web-address, ci, ...)');
      const d = decide({ batches, area, today, maxAgeDays });
      if (args.includes('--apply')) d.worktree = apply(cwd, d, config.protectedBranch);
      console.log(json ? JSON.stringify(d, null, 2) : [
        `${d.action === 'join' ? 'JOIN' : 'NEW'} ${d.batch}`,
        d.worktree ? `work in: ${d.worktree}` : 'dry run: add --apply to create or reuse the worktree',
        d.stale.length && `stale (older than ${maxAgeDays} days, never joined; close or abandon): ${d.stale.join(', ')}`,
      ].filter(Boolean).join('\n'));
    }
  } catch (e) {
    console.error(`triage: ${e.message}`);
    process.exit(1);
  }
}
