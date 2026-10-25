#!/usr/bin/env node
// Branch triage. New work joins today's batch unless there is a reason not to; the scripts do the git work.
//   triage.mjs list                        batches with their state, fixes, files, and what shipping them costs
//   triage.mjs today                       today's batch ship/day-<YYYYMMDD>, created from the live branch if missing
//   triage.mjs new <name> --reason "..."   a separate batch ship/<name>-<YYYYMMDD>; needs a reason (soloPaths, batch full, the user asked)
//   triage.mjs hotfix <name>               hotfix/<name> from the live branch in its own worktree: a normal PR to the live branch
//   triage.mjs prune [--apply]             worktrees whose branch's PR has merged and that hold no uncommitted work; --apply removes them
// Then work on fixes with fix.mjs (start, done) and ship a batch with ship.mjs.
// Options: --json, --no-install (hotfix: skip installing dependencies)
import { existsSync, renameSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { sh, trySh, lines, q, ymd, slugify, worktrees, wtPath, install, usesMergify, readJson, writeJson, sessionFile } from './lib.mjs';
export { ymd, slugify } from './lib.mjs';

const DAY = 86_400_000;
export const ageDays = (created, today) => Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - created) / DAY);
export const DAY_SLUG = 'day';
const LOCKFILES = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|uv\.lock|Cargo\.lock|poetry\.lock)$/;

// ship/<name>-<YYYYMMDD>[-<n>]; anything else is not a batch.
export function parseBatch(name) {
  const m = name.match(/^ship\/(.+?)-(\d{4})(\d\d)(\d\d)(?:-\d+)?$/);
  return m && { name, slug: m[1], created: new Date(+m[2], +m[3] - 1, +m[4]).getTime() };
}

export function batchName(name, today, taken) {
  let batch = `ship/${slugify(name)}-${ymd(today)}`;
  for (let i = 2; taken.has(batch); i++) batch = `ship/${slugify(name)}-${ymd(today)}-${i}`;
  return batch;
}

// The rules for joining, all checkable facts. Lockfiles do not count towards the size cap.
export function whyNotJoinable(b, today, { batchMaxAgeDays = 0, batchMaxFiles = 0 } = {}) {
  if (b.state === 'done') return 'merged or closed';
  if (b.state === 'frozen') return 'marked ready: frozen';
  if (b.state === 'closing') return 'shipping: its PR to the live branch is open';
  const age = ageDays(b.created, today);
  if (age > batchMaxAgeDays) return batchMaxAgeDays ? `older than ${batchMaxAgeDays} days` : 'from an earlier day: ship it; new work goes in today\'s batch';
  if (batchMaxFiles && (b.files || []).filter((f) => !LOCKFILES.test(f)).length >= batchMaxFiles) return `full (${batchMaxFiles}+ files): ship it; new work goes in a new batch`;
  if (b.solo) return 'holds soloPaths changes, which ship alone';
  return '';
}

// State comes from the batch's PR to the live branch: none = open, draft = closing, ready = frozen, merged/closed = done.
// Fix PRs are the PRs whose base is the batch.
export function listBatches(cwd, { live, soloPaths = [] }) {
  trySh('git fetch -q --prune origin', cwd);
  const names = new Set(lines(trySh("git for-each-ref --format='%(refname:short)' refs/remotes/origin/ship/ refs/heads/ship/", cwd))
    .map((r) => r.replace(/^origin\//, '')));
  let prs = [];
  try { prs = JSON.parse(trySh('gh pr list --state all --limit 300 --json number,title,url,headRefName,baseRefName,state,isDraft', cwd) || '[]'); } catch {}
  const wts = worktrees(cwd);
  return [...names].map(parseBatch).filter(Boolean).map((b) => {
    const p = prs.find((x) => x.headRefName === b.name && x.baseRefName === live) || prs.find((x) => x.headRefName === b.name);
    const ref = trySh(`git rev-parse --verify -q origin/${b.name}`, cwd) ? `origin/${b.name}` : b.name;
    const files = lines(trySh(`git diff --name-only origin/${live}...${ref}`, cwd));
    return {
      ...b,
      state: !p ? 'open' : p.state !== 'OPEN' ? 'done' : p.isDraft ? 'closing' : 'frozen',
      pr: p ? { number: p.number, title: p.title, url: p.url } : null,
      fixes: prs.filter((x) => x.baseRefName === b.name).map((x) => ({ number: x.number, title: x.title, state: x.state === 'OPEN' ? 'open' : x.state.toLowerCase() })),
      commits: lines(trySh(`git log --first-parent --no-merges --format=%s origin/${live}..${ref}`, cwd)),
      files,
      worktree: wts[b.name] || null,
      solo: files.some((f) => soloPaths.some((s) => f.startsWith(s))),
    };
  });
}

// Creates a batch branch from the live branch and pushes it (free: CI runs only on PRs to the live branch).
// A reason, when given, is kept as the batch's first commit so the batch PR can show why it exists.
function createBatch(cwd, batch, config, reason) {
  sh(`git fetch -q origin ${config.protectedBranch}`, cwd);
  sh(`git push -q origin ${q(`origin/${config.protectedBranch}`)}:refs/heads/${batch}`, cwd);
  if (reason) {
    const tree = sh(`git rev-parse origin/${config.protectedBranch}^{tree}`, cwd);
    const c = sh(`git commit-tree ${tree} -p origin/${config.protectedBranch} -m ${q(`batch: ${reason}`)}`, cwd);
    sh(`git push -q origin ${c}:refs/heads/${batch}`, cwd);
  }
  sh(`git fetch -q origin ${batch}`, cwd);
  return batch;
}

// Today's batch: the first joinable ship/day-<today>[-n], created if there is none.
export function todayBatch(cwd, { batches, today, config }) {
  const ok = batches.filter((b) => b.slug === DAY_SLUG && ageDays(b.created, today) === 0 && !whyNotJoinable(b, today, config)).sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
  if (ok.length) return { action: 'today', batch: ok[0].name, created: false };
  return { action: 'today', batch: createBatch(cwd, batchName(DAY_SLUG, today, new Set(batches.map((b) => b.name))), config), created: true };
}

export function newBatch(cwd, name, { batches, today, config, reason }) {
  if (!slugify(name) || slugify(name) === DAY_SLUG) throw new Error('name the batch after what it holds, e.g. triage.mjs new ci-runners --reason "..."');
  if (!reason) throw new Error('a separate batch needs --reason: it touches soloPaths, today\'s batch is full, or the user asked for it. Otherwise use today\'s batch (fix.mjs start <name>).');
  return { action: 'new', batch: createBatch(cwd, batchName(name, today, new Set(batches.map((b) => b.name))), config, reason), reason };
}

// batchPer "session": the session keeps its own batch while it takes fixes; once it ships (or a new day starts) the next fix
// opens a new one, named after that fix. The reason commit says whose batch it is.
export function sessionBatch(cwd, { batches, today, config, session, name }) {
  const f = sessionFile(cwd);
  // Entries whose batch merged or closed are dropped, so the file does not grow forever.
  const done = new Set(batches.filter((b) => b.state === 'done').map((b) => b.name));
  const map = Object.fromEntries(Object.entries(readJson(f) || {}).filter(([, v]) => !done.has(v)));
  const mine = map[session] && batches.find((b) => b.name === map[session]);
  if (mine && !whyNotJoinable(mine, today, config)) return { action: 'session', batch: mine.name, created: false };
  const slug = slugify(name) && slugify(name) !== DAY_SLUG ? name : 'thread';
  const r = newBatch(cwd, slug, { batches, today, config, reason: `one batch per thread (session ${String(session).slice(0, 8)})` });
  saveSession(f, map, session, r.batch);
  return { action: 'session', batch: r.batch, created: true };
}

// Written to a temp file and renamed, so a reader never sees half a file. The newest entries on disk are merged in first,
// last, so two sessions starting at once do not drop each other's entry.
function saveSession(f, map, session, batch) {
  const tmp = `${f}.${process.pid}.tmp`;
  writeJson(tmp, { ...map, ...(readJson(f) || {}), [session]: batch });
  renameSync(tmp, f);
}
export const rememberSession = (cwd, session, batch) => saveSession(sessionFile(cwd), {}, session, batch);

// Where new work goes: the session's own batch (batchPer "session", inside an agent session), else today's batch.
export function nextBatch(cwd, { batches, today, config, session, name }) {
  return config.batchPer === 'session' && session ? sessionBatch(cwd, { batches, today, config, session, name }) : todayBatch(cwd, { batches, today, config });
}

// The batch this session is filling, when batchPer is "session".
export const sessionBatchName = (cwd, session) => (session && (readJson(sessionFile(cwd)) || {})[session]) || null;

export function hotfix(cwd, name, { config, install: doInstall = true }) {
  if (!slugify(name)) throw new Error('name the hotfix, e.g. triage.mjs hotfix checkout-500');
  const branch = `${config.hotfixPrefixes[0]}${slugify(name)}`;
  sh(`git fetch -q origin ${config.protectedBranch}`, cwd);
  const path = wtPath(cwd, branch);
  sh(`git worktree add -q -b ${branch} ${q(path)} origin/${config.protectedBranch}`, cwd);
  return { action: 'hotfix', batch: branch, worktree: path, install: doInstall ? install(path, config) : null };
}

// Worktrees safe to remove: not the main checkout, not a reused worker, branch merged through a PR, nothing uncommitted,
// and no local commit that only this branch holds (kept: the tip is the merged PR's head, or a remote branch has it).
export function pruneCandidates(wts, { main, merged, dirty, kept = () => true }) {
  return wts.filter((w) => w.path !== main && w.branch && !/\/worker-\d+$/.test(w.path) && merged.has(w.branch) && !dirty(w.path) && kept(w));
}

export function prune(cwd, { apply = false }) {
  const main = sh('git worktree list --porcelain', cwd).split('\n')[0].slice(9);
  const wts = Object.entries(worktrees(cwd)).filter(([b]) => !b.startsWith('(detached)')).map(([branch, path]) => ({ branch, path }));
  let prs = [];
  try { prs = JSON.parse(trySh('gh pr list --state merged --limit 500 --json headRefName,headRefOid', cwd) || '[]'); } catch {}
  const merged = new Set(prs.map((p) => p.headRefName));
  const heads = new Set(prs.map((p) => p.headRefOid));
  const kept = (w) => { const tip = trySh(`git rev-parse ${q(w.branch)}`, cwd); return heads.has(tip) || !!trySh(`git branch -r --contains ${tip}`, cwd); };
  const gone = pruneCandidates(wts, { main, merged, kept, dirty: (p) => !existsSync(p) || !!trySh('git status --porcelain', p) });
  if (apply) for (const w of gone) { trySh(`git worktree remove ${q(w.path)}`, cwd); trySh(`git branch -D ${q(w.branch)}`, cwd); }
  return { action: 'prune', removed: apply, worktrees: gone };
}

function show(b, today, config) {
  const age = ageDays(b.created, today);
  const why = whyNotJoinable(b, today, config);
  const openFixes = b.fixes.filter((f) => f.state === 'open');
  return [
    `${b.name}  (${age ? `${age}d old` : 'today'}, ${b.state}${b.pr ? `, PR #${b.pr.number}` : ''})`,
    `  ${why ? `not joinable: ${why}` : 'joinable'}`,
    b.commits.length && `  fixes in it (${b.commits.length}): ${b.commits.slice(0, 8).join(' | ')}${b.commits.length > 8 ? ` | +${b.commits.length - 8} more` : ''}`,
    openFixes.length && `  open fix PRs: ${openFixes.map((f) => `#${f.number} ${f.title}`).join(' | ')}`,
    b.files.length && `  files: ${b.files.length}`,
  ].filter(Boolean).join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const reason = flag('reason');
  const json = args.includes('--json');
  const [cmd, name] = args.filter((a) => !a.startsWith('--'));
  try {
    const cwd = sh('git rev-parse --show-toplevel');
    const config = loadConfig(cwd);
    const today = new Date();
    const batches = listBatches(cwd, { live: config.protectedBranch, soloPaths: config.soloPaths });
    const opts = { batches, today, config, reason, install: !args.includes('--no-install') };
    if (cmd === 'list' || !cmd) {
      const open = batches.filter((b) => b.state !== 'done').sort((a, b) => b.created - a.created || a.name.localeCompare(b.name));
      const paying = open.filter((b) => b.commits.length).length;
      if (json) console.log(JSON.stringify(open, null, 2));
      else console.log([open.map((b) => show(b, today, config)).join('\n\n') || 'no open batches',
        `\n${paying} batch(es) with fixes = ${paying} full CI run(s) when shipped, plus ${paying} on ${config.protectedBranch} after merging. New work joins today's batch (fix.mjs start <name>).`].join('\n'));
    } else {
      if (cmd === 'prune') {
        const r = prune(cwd, { apply: args.includes('--apply') });
        console.log(json ? JSON.stringify(r, null, 2) : r.worktrees.length
          ? `${r.removed ? 'Removed' : 'Would remove (run with --apply)'}:\n${r.worktrees.map((w) => `  ${w.branch}  ${w.path}`).join('\n')}`
          : 'Nothing to prune: no clean worktree with a merged branch.');
        process.exit(0);
      }
      const act = { today: todayBatch, new: newBatch, hotfix }[cmd];
      if (!act) throw new Error(`unknown command ${cmd}; use list, today, new <name> --reason "...", hotfix <name>, or prune [--apply]`);
      const r = cmd === 'today' ? act(cwd, opts) : act(cwd, name, opts);
      console.log(json ? JSON.stringify(r, null, 2) : [
        `${r.action.toUpperCase()} ${r.batch}${r.created ? ' (created)' : ''}`,
        r.worktree && `work in: ${r.worktree}`,
        r.install && `${r.install.ok ? 'installed' : 'INSTALL FAILED, run it by hand'}: ${r.install.cmd}`,
        r.action === 'hotfix' && (usesMergify(cwd, config)
          ? `Commit there, push, then open a normal PR to ${config.protectedBranch}, mark it ready and queue it: gh pr comment <PR> --body '@mergifyio queue' (the queue merges it after CI, ahead of batches). Allowed only when the user asked for a hotfix in this session.`
          : `Commit there, push, then open a normal PR to ${config.protectedBranch}. Marking it ready and merging is allowed only when the user asked for a hotfix in this session.`),
      ].filter(Boolean).join('\n'));
    }
  } catch (e) {
    console.error(`triage: ${e.stderr?.toString().trim() || e.message}`);
    process.exit(1);
  }
}
