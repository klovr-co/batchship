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
// "hotfix": a hotfix/* PR may be opened ready, marked ready and merged.
// "ship": once every fix the user gave in the session is done, the batch ships (ready, CI, merge) without waiting for the day.
export const UNLOCK_MS = 2 * 3600_000;
// Only an explicit request counts, so talking about hotfixes or shipping does not unlock anything:
//   a line starting "hotfix: checkout returns 500", "hotfix the login loop", "/ship-batch hotfix ..."   -> hotfix
//   "... and ship when done", "ship it once they're finished", "then ship", "ship after these",
//   "ship at the end", "ship now", "/ship-batch ship --merge"                                        -> ship
// Not when the line is a question, or the phrase is quoted or follows "if" / "say".
const SHIP = /\b(?:then\s+ship\b(?!\s+(?:flow|design|step|script))|ship(?:\s+(?:it|them|everything|all|these|this|the\s+batch|today'?s\s+batch))?\s+(?:(?:when|once|after)\s+(?:(?:it|they|everything|all|the\s+list|this|these|those|we)(?:'?s|'?re|\s+is|\s+are)?\s+)?(?:all\s+)?(?:done|finished|complete|completed)\b|after\s+(?:this|these|that|them|it|the\s+list|everything)\b|at\s+the\s+end\b|now\b))/i;
export function intents(prompt = '') {
  const ls = String(prompt).split('\n').map((l) => l.trim().replace(/^(please|pls|ok|okay|go|now|and)[,:]?\s+/i, ''));
  const asked = (l) => !/\?\s*$/.test(l);
  const kinds = [];
  if (ls.some((l) => asked(l) && /^(\/\S*ship-batch\s+)?hot[\s-]?fix\b(?!\s+(design|flow|path|mode|process|rule))/i.test(l))) kinds.push('hotfix');
  if (ls.some((l) => {
    if (!asked(l)) return false;
    if (/^\/\S*ship-batch\s+ship\b.*--merge\b/i.test(l)) return true;
    const m = SHIP.exec(l);
    return m && !/\b(if|say|says|said|saying|type|types)\b|["'`“]\s*$/i.test(l.slice(0, m.index));
  })) kinds.push('ship');
  return kinds;
}
export const unlockFile = (cwd) => join(resolve(cwd, sh('git rev-parse --git-common-dir', cwd)), 'batchship-unlock.json');
export function grant(cwd, session, kinds, now = Date.now()) {
  const f = unlockFile(cwd);
  const all = Object.fromEntries(Object.entries(readJson(f) || {}).filter(([, v]) => v.until > now));
  const prev = all[session || 'none']?.kinds || [];
  all[session || 'none'] = { kinds: [...new Set([...prev, ...kinds])], until: now + UNLOCK_MS };
  writeJson(f, all);
}
// Grants are per session: the guard passes the hook's session_id, scripts pass CLAUDE_CODE_SESSION_ID.
// This stops agents by mistake, not on purpose: any process on the machine can write files.
export function unlocked(cwd, session, now = Date.now()) {
  let all;
  try { all = readJson(unlockFile(cwd)) || {}; } catch { return new Set(); }
  const live = Object.entries(all).filter(([s, v]) => v.until > now && s === (session || 'none'));
  return new Set(live.flatMap(([, v]) => v.kinds));
}

// Mergify: when the repo uses its merge queue, the queue merges batch PRs into the live branch, not ship.mjs.
// It tests each PR against the newest live branch first, so a batch never lands on code it was not tested with.
export const usesMergify = (cwd, config) => config.mergeVia === 'mergify' || (config.mergeVia !== 'gh' && existsSync(join(cwd, '.mergify.yml')));

// The newest queue state Mergify wrote on a PR, from the JSON payload in its comments:
// { state: 'queued' | 'checking' | 'dequeued' | ..., left_at?, dequeue_reason?: { code, label, checks } }. null when none.
export function mergifyState(comments = []) {
  for (const c of [...comments].reverse()) {
    if (!/mergify/i.test(c.author?.login || '')) continue;
    const m = String(c.body || '').match(/-\*- Mergify Payload -\*-\s*([\s\S]*?)\s*-\*- Mergify Payload End -\*-/);
    if (!m) continue;
    try { return JSON.parse(m[1]); } catch {}
  }
  return null;
}

// Where a queued PR stands, from `gh pr view --json state,comments`: merged, still going, or out of the queue after `since` (ms).
export function queueOutcome(view, since) {
  if (view.state === 'MERGED') return { done: 'merged' };
  if (view.state === 'CLOSED') return { done: 'closed' };
  const s = mergifyState(view.comments);
  if (s?.state === 'dequeued' && Date.parse(s.left_at || 0) >= since)
    return { done: 'dequeued', reason: s.dequeue_reason?.label || s.dequeue_reason?.code || 'left the queue', checks: s.dequeue_reason?.checks || [] };
  return { done: null, state: s?.state || 'waiting' };
}

// When a repair is the human's, not the agent's: what ship.mjs tells the agent before it starts one.
export const ESCALATE = 'Hand it to the human instead of repairing when the repair would touch soloPaths, change more than about 5 files or 200 lines, '
  + 'need a schema or data migration, a secret, or a CI or infrastructure change, or when the failure is outside this batch\'s files and also fails on the live branch.';
