#!/usr/bin/env node
// Branch triage. The agent decides which changes belong together; this script gives it the facts and does the git work.
//   triage.mjs list               open batches: age, PR, commits, files, busy, and whether each can be joined
//   triage.mjs new <name>         new batch ship/<name>-<YYYYMMDD> from the live branch, pushed, in its own worktree
//   triage.mjs join <batch>       reuse a batch and its worktree (refused if ready, merged, too old, mid-edit or solo)
//   triage.mjs adopt <name>       rename the current work branch (e.g. a T3 thread's) into a batch
// Options: --json, --no-install (skip installing dependencies in a new worktree)
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { packageManager } from './detect.mjs';

const DAY = 86_400_000;
// Local dates, so a batch is named after the day you are working in, not the UTC day.
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
export const ageDays = (created, today) => Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - created) / DAY);
export const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ship/<name>-<YYYYMMDD>[-<n>]; anything else is not a triage batch.
export function parseBatch(name) {
  const m = name.match(/^ship\/(.+?)-(\d{4})(\d\d)(\d\d)(?:-\d+)?$/);
  return m && { name, slug: m[1], created: new Date(+m[2], +m[3] - 1, +m[4]).getTime() };
}

export function batchName(name, today, taken) {
  let batch = `ship/${slugify(name)}-${ymd(today)}`;
  for (let i = 2; taken.has(batch); i++) batch = `ship/${slugify(name)}-${ymd(today)}-${i}`;
  return batch;
}

// The only hard rules. Which batch a change belongs in is the agent's call.
export function whyNotJoinable(b, today, maxAgeDays = 7) {
  if (b.state === 'done') return 'merged or closed';
  if (b.state === 'frozen') return 'marked ready: frozen';
  if (ageDays(b.created, today) > maxAgeDays) return `older than ${maxAgeDays} days: stale, close or abandon it`;
  if (b.busy) return 'another worker is mid-edit in its worktree';
  if (b.solo) return 'holds soloPaths changes, which ship alone';
  return '';
}

const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const trySh = (cmd, cwd) => { try { return sh(cmd, cwd); } catch { return ''; } };
const lines = (s) => s.split('\n').filter(Boolean);

function worktrees(cwd) {
  const map = {};
  let path;
  for (const line of lines(trySh('git worktree list --porcelain', cwd))) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    if (line.startsWith('branch refs/heads/')) map[line.slice(18)] = path;
  }
  return map;
}

// State comes from the PR: merged/closed = done, ready = frozen, draft or no PR = open.
export function listBatches(cwd, { live, soloPaths = [] }) {
  trySh('git fetch -q --prune origin', cwd);
  const names = new Set(lines(trySh("git for-each-ref --format='%(refname:short)' refs/remotes/origin/ship/ refs/heads/ship/", cwd))
    .map((r) => r.replace(/^origin\//, '')));
  const prs = {};
  try { for (const p of JSON.parse(trySh('gh pr list --state all --limit 200 --json number,title,url,headRefName,state,isDraft', cwd) || '[]')) prs[p.headRefName] ??= p; } catch {}
  const wts = worktrees(cwd);
  return [...names].map(parseBatch).filter(Boolean).map((b) => {
    const p = prs[b.name];
    const ref = trySh(`git rev-parse --verify -q refs/heads/${b.name}`, cwd) ? b.name : `origin/${b.name}`;
    const files = lines(trySh(`git diff --name-only origin/${live}...${ref}`, cwd));
    const worktree = wts[b.name] || null;
    return {
      ...b,
      state: !p ? 'open' : p.state !== 'OPEN' ? 'done' : p.isDraft ? 'open' : 'frozen',
      pr: p ? { number: p.number, title: p.title, url: p.url } : null,
      commits: lines(trySh(`git log --format=%s origin/${live}..${ref}`, cwd)),
      files,
      worktree,
      busy: !!(worktree && existsSync(worktree) && trySh('git status --porcelain', worktree)),
      solo: files.some((f) => soloPaths.some((s) => f.startsWith(s))),
    };
  });
}

function install(path, config) {
  const cmd = config.setup || (existsSync(join(path, 'package.json')) && {
    pnpm: 'pnpm install --frozen-lockfile', bun: 'bun install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile',
    npm: existsSync(join(path, 'package-lock.json')) ? 'npm ci' : 'npm install',
  }[packageManager(path)]) || (existsSync(join(path, 'uv.lock')) && 'uv sync');
  if (!cmd) return null;
  const ok = spawnSync(cmd, { cwd: path, shell: true, stdio: ['ignore', 2, 2] }).status === 0; // keep stdout clean for --json
  return { cmd, ok };
}

function addWorktree(cwd, batch, opts) {
  const repo = dirname(resolve(cwd, sh('git rev-parse --git-common-dir', cwd)));
  const path = join(dirname(repo), '.batchship-wt', basename(repo), batch.replaceAll('/', '__'));
  sh(`git worktree add -q "${path}" ${batch}`, cwd);
  return { worktree: path, install: opts.install ? install(path, opts.config) : null };
}

export function newBatch(cwd, name, { batches, today, config, install = true }) {
  if (!slugify(name)) throw new Error('name the batch after the feature or problem, e.g. triage.mjs new checkout-flow');
  const batch = batchName(name, today, new Set(batches.map((b) => b.name)));
  sh(`git branch ${batch} origin/${config.protectedBranch}`, cwd);
  const out = addWorktree(cwd, batch, { install, config });
  sh(`git push -q -u origin ${batch}`, out.worktree); // free: no workflow runs on ship/*
  return { action: 'new', batch, ...out };
}

export function joinBatch(cwd, name, { batches, today, config, install = true }) {
  const b = batches.find((x) => x.name === name || x.name === `ship/${name}`);
  if (!b) throw new Error(`no batch ${name}; run triage.mjs list`);
  const why = whyNotJoinable(b, today, config.batchMaxAgeDays);
  if (why) throw new Error(`cannot join ${b.name}: ${why}. Start a new batch instead.`);
  if (b.worktree && existsSync(b.worktree)) { trySh('git pull -q --ff-only', b.worktree); return { action: 'join', batch: b.name, worktree: b.worktree, install: null }; }
  if (!trySh(`git rev-parse --verify -q refs/heads/${b.name}`, cwd)) sh(`git branch --track ${b.name} origin/${b.name}`, cwd);
  return { action: 'join', batch: b.name, ...addWorktree(cwd, b.name, { install, config }) };
}

// For work already started on its own branch (a T3 thread's worktree): turn that branch into a batch in place.
export function adoptBranch(cwd, name, { batches, today, config }) {
  const current = sh('git branch --show-current', cwd);
  if (current.startsWith('ship/')) return { action: 'adopt', batch: current, worktree: cwd };
  if ([config.protectedBranch, ...(config.manualBranches || [])].includes(current) || !current)
    throw new Error(`you are on ${current || 'a detached HEAD'}; use triage.mjs new <name> instead`);
  const batch = batchName(name, today, new Set(batches.map((b) => b.name)));
  sh(`git branch -m ${batch}`, cwd);
  sh(`git push -q -u origin ${batch}`, cwd);
  return { action: 'adopt', batch, worktree: cwd, renamedFrom: current };
}

function show(b, today, max) {
  const age = ageDays(b.created, today);
  const why = whyNotJoinable(b, today, max);
  return [
    `${b.name}  (${age ? `${age}d old` : 'today'}, ${b.state}${b.pr ? `, PR #${b.pr.number} ${b.pr.title}` : ', no PR yet'})`,
    `  ${why ? `NOT joinable: ${why}` : 'joinable'}`,
    b.commits.length && `  commits: ${b.commits.slice(0, 8).join(' | ')}${b.commits.length > 8 ? ` | +${b.commits.length - 8} more` : ''}`,
    b.files.length && `  files: ${b.files.slice(0, 12).join(', ')}${b.files.length > 12 ? ` +${b.files.length - 12} more` : ''}`,
    `  worktree: ${b.worktree || '-'}`,
  ].filter(Boolean).join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, name] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const json = process.argv.includes('--json');
  try {
    const cwd = sh('git rev-parse --show-toplevel');
    const config = loadConfig(cwd);
    const today = new Date();
    const batches = listBatches(cwd, { live: config.protectedBranch, soloPaths: config.soloPaths });
    const opts = { batches, today, config, install: !process.argv.includes('--no-install') };
    if (cmd === 'list' || !cmd) {
      const open = batches.filter((b) => b.state !== 'done').sort((a, b) => b.created - a.created);
      console.log(json ? JSON.stringify(open, null, 2) : open.map((b) => show(b, today, config.batchMaxAgeDays)).join('\n\n') || 'no open batches');
    } else {
      const act = { new: newBatch, join: joinBatch, adopt: adoptBranch }[cmd];
      if (!act) throw new Error(`unknown command ${cmd}; use list, new <name>, join <batch> or adopt <name>`);
      const r = act(cwd, name, opts);
      console.log(json ? JSON.stringify(r, null, 2) : [
        `${r.action.toUpperCase()} ${r.batch}${r.renamedFrom ? ` (was ${r.renamedFrom})` : ''}`,
        `work in: ${r.worktree}`,
        r.install && `${r.install.ok ? 'installed' : 'INSTALL FAILED, run it by hand'}: ${r.install.cmd}`,
      ].filter(Boolean).join('\n'));
    }
  } catch (e) {
    console.error(`triage: ${e.stderr?.toString().trim() || e.message}`);
    process.exit(1);
  }
}
