// Shared git and worktree helpers for triage.mjs, fix.mjs and ship.mjs.
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { packageManager } from './detect.mjs';

export const sh = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }).trim();
export const trySh = (cmd, cwd) => { try { return sh(cmd, cwd); } catch { return ''; } };
export const lines = (s) => s.split('\n').filter(Boolean);
export const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`; // shell-quote one argument

const pad = (n) => String(n).padStart(2, '0');
// Local dates, so a batch is named after the day you are working in, not the UTC day.
export const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
export const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const repoDir = (cwd) => dirname(resolve(cwd, sh('git rev-parse --git-common-dir', cwd)));
// Worktrees live next to the repo: <parent>/.batchship-wt/<repo>/<name>.
export const wtRoot = (cwd) => { const r = repoDir(cwd); return join(dirname(r), '.batchship-wt', basename(r)); };
export const wtPath = (cwd, name) => join(wtRoot(cwd), name.replaceAll('/', '__'));

// branch -> worktree path
export function worktrees(cwd) {
  const map = {};
  let path;
  for (const line of lines(trySh('git worktree list --porcelain', cwd))) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    if (line.startsWith('branch refs/heads/')) map[line.slice(18)] = path;
    if (line === 'detached') map[`(detached) ${path}`] = path;
  }
  return map;
}

export const gitPath = (cwd, name) => resolve(cwd, sh(`git rev-parse --git-path ${name}`, cwd));
export const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
export const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

// The repo has a GitHub remote that gh can reach: PRs. Otherwise (a local origin) everything merges locally.
export const onGitHub = (cwd) => !!trySh('gh repo view --json name -q .name', cwd);

export function install(path, config) {
  const cmd = config.setup || (existsSync(join(path, 'package.json')) && {
    pnpm: 'pnpm install --frozen-lockfile', bun: 'bun install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile',
    npm: existsSync(join(path, 'package-lock.json')) ? 'npm ci' : 'npm install',
  }[packageManager(path)]) || (existsSync(join(path, 'uv.lock')) && 'uv sync');
  if (!cmd) return null;
  const ok = spawnSync(cmd, { cwd: path, shell: true, stdio: ['ignore', 2, 2] }).status === 0; // keep stdout clean for --json
  return { cmd, ok };
}

// A checkout of a batch branch, for merging into it (fix done in local mode, ship, eject). Reuses the batch's worktree.
export function batchCheckout(cwd, batch) {
  const at = worktrees(cwd)[batch];
  if (at && existsSync(at)) { trySh(`git pull -q --ff-only origin ${batch}`, at); return at; }
  const path = wtPath(cwd, batch);
  if (!trySh(`git rev-parse --verify -q refs/heads/${batch}`, cwd)) sh(`git branch --track ${batch} origin/${batch}`, cwd);
  sh(`git worktree add -q ${q(path)} ${batch}`, cwd);
  trySh(`git pull -q --ff-only origin ${batch}`, path);
  return path;
}

// Workflows whose pull_request trigger has no branch filter run on PRs into ship/* too, so fix PRs would cost CI.
export function unfilteredPrWorkflows(cwd) {
  const dir = join(cwd, '.github/workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).filter((f) => {
    const y = readFileSync(join(dir, f), 'utf8');
    const m = y.match(/^\s*pull_request:\s*\n((?:\s{4,}.*\n?)*)/m) || (/^\s*on:.*\bpull_request\b/m.test(y) ? [null, ''] : null);
    return m && !/branches/.test(m[1]);
  });
}

// What the user explicitly asked for in a session, recorded by the prompt hook (intent.mjs) and read by the guard and ship.mjs.
// "hotfix": a hotfix/* PR may be opened ready, marked ready and merged. "ship-now": a batch may ship without waiting for the day.
export const UNLOCK_MS = 2 * 3600_000;
export function intents(prompt = '') {
  const p = String(prompt);
  const kinds = [];
  if (/\bhot[\s-]?fix(es|ing)?\b/i.test(p)) kinds.push('hotfix');
  if (/\b(ship|merge|release|deploy)\b[^.?!\n]{0,40}\b(now|right now|right away|immediately|asap)\b/i.test(p) || /\b(don'?t|do not|no need to) wait\b/i.test(p) || /\bskip the (daily )?batch\b/i.test(p)) kinds.push('ship-now');
  return kinds;
}
export const unlockFile = (cwd) => join(resolve(cwd, sh('git rev-parse --git-common-dir', cwd)), 'batchship-unlock.json');
export function grant(cwd, session, kinds, now = Date.now()) {
  const f = unlockFile(cwd);
  const all = Object.fromEntries(Object.entries(readJson(f) || {}).filter(([, v]) => v.until > now));
  const prev = all[session || 'any']?.kinds || [];
  all[session || 'any'] = { kinds: [...new Set([...prev, ...kinds])], until: now + UNLOCK_MS };
  writeJson(f, all);
}
// Grants are per session: the guard passes the hook's session_id, scripts pass CLAUDE_CODE_SESSION_ID.
// This stops agents by mistake, not on purpose: any process on the machine can write files.
export function unlocked(cwd, session, now = Date.now()) {
  let all;
  try { all = readJson(unlockFile(cwd)) || {}; } catch { return new Set(); }
  const live = Object.entries(all).filter(([s, v]) => v.until > now && s === session);
  return new Set(live.flatMap(([, v]) => v.kinds));
}
