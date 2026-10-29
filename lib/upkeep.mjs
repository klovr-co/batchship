// tug upkeep: daily, for every repo in ~/.config/tug/repos (portable: macOS and Linux).
// 1. Fast-forward each root checkout to origin/<ship branch> (never merges; refuses when local edits are in the way).
// 2. Remove worktrees whose PR is merged or closed (and none open), whose every commit is in a pushed PR head,
//    that have no uncommitted changes, and that have been idle 2+ days. Never `worktree remove --force`.
// 3. Run doctor on each repo.
import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { doctorChecks, formatDoctor } from './doctor.mjs';
import { git, gitOk, tryGit } from './git.mjs';
import { createClient } from './gh.mjs';
import { readRegistry } from './registry.mjs';

export const IDLE_DAYS = 2;

/** `git worktree list --porcelain` as [{ path, branch|null, detached }]. */
export function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: null, detached: false };
      out.push(cur);
    } else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (cur && line === 'detached') cur.detached = true;
  }
  return out;
}

/**
 * Whether a worktree may go. Pure: the caller supplies facts.
 * prs: [{ headRefName, state, headRefOid }]; containedIn(oid): HEAD is an ancestor of oid; idleDays; dirty.
 * Returns { remove: bool, reason }.
 */
export function decideWorktree({ branch, prs, containedIn, idleDays, dirty }) {
  if (!branch) return { remove: false, reason: 'detached HEAD' };
  const mine = prs.filter(p => p.headRefName === branch);
  if (!mine.length) return { remove: false, reason: 'no PR' };
  if (mine.some(p => p.state === 'OPEN')) return { remove: false, reason: 'PR open' };
  const done = mine.find(p => p.state === 'MERGED') || mine.find(p => p.state === 'CLOSED');
  if (!done) return { remove: false, reason: 'PR not finished' };
  if (!mine.some(p => p.headRefOid && containedIn(p.headRefOid))) return { remove: false, reason: 'unpushed', keptFinished: true };
  if (idleDays < IDLE_DAYS) return { remove: false, reason: 'recently used' };
  if (dirty) return { remove: false, reason: 'uncommitted changes', keptFinished: true };
  return { remove: true, reason: `PR ${done.state}` };
}

/** Days since a worktree was last used: its index file's mtime (or its .git file's). */
export function idleDays(worktree, nowMs = Date.now()) {
  let last = 0;
  let idx = tryGit(worktree, ['rev-parse', '--git-path', 'index']);
  if (idx && !isAbsolute(idx)) idx = join(worktree, idx);
  for (const p of [idx, join(worktree, '.git')]) {
    try {
      if (p && existsSync(p)) {
        last = statSync(p).mtimeMs;
        break;
      }
    } catch { /* try the next */ }
  }
  return last ? Math.floor((nowMs - last) / 86_400_000) : Infinity;
}

function upkeepRepo({ root, base, slug }, { dryRun, log, clientFor }) {
  let fail = 0;
  const name = basename(root);
  const FAIL = text => { fail = 1; log(`FAIL ${name}: ${text}`); };
  if (!existsSync(root) || !gitOk(root, ['rev-parse', '--git-dir'])) return FAIL(`${root} is not a git checkout`), fail;
  if (!gitOk(root, ['fetch', '-q', '--prune', 'origin'])) return FAIL('fetch failed'), fail;

  // 1. Root checkout.
  const cur = tryGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const behind = Number(tryGit(root, ['rev-list', '--count', `HEAD..origin/${base}`]) ?? 0);
  if (cur !== base) FAIL(`root is on '${cur}', not '${base}'; left alone`);
  else if (behind > 0) {
    if (dryRun) log(`would pull ${name}: ${behind} behind origin/${base}`);
    else if (gitOk(root, ['merge', '-q', '--ff-only', `origin/${base}`])) log(`pulled ${name}: +${behind} commits`);
    else FAIL(`root is ${behind} behind origin/${base} and your uncommitted edits block a fast-forward (${(tryGit(root, ['status', '--short']) || '').split('\n').filter(Boolean).length} files changed)`);
  }

  // 2. Worktrees.
  let prs;
  try {
    prs = clientFor(slug).allPrs();
  } catch {
    return FAIL('gh pr list failed; no worktrees removed'), fail;
  }
  let removed = 0;
  let kept = 0;
  const now = Date.now();
  for (const wt of parseWorktrees(git(root, ['worktree', 'list', '--porcelain']))) {
    if (!wt.path || wt.path === root || !existsSync(wt.path)) continue;
    const decision = decideWorktree({
      branch: wt.detached ? null : wt.branch,
      prs,
      containedIn: oid => gitOk(wt.path, ['merge-base', '--is-ancestor', 'HEAD', oid]),
      idleDays: idleDays(wt.path, now),
      // --no-optional-locks: a plain status refreshes the index, which resets the idle clock read above.
      dirty: !!tryGit(wt.path, ['--no-optional-locks', 'status', '--porcelain']),
    });
    if (decision.keptFinished) kept++;
    if (!decision.remove) continue;
    if (dryRun) log(`would remove ${name}: ${wt.path} [${wt.branch}, ${decision.reason}]`);
    else if (gitOk(root, ['worktree', 'remove', wt.path])) {
      gitOk(root, ['branch', '-D', '-q', wt.branch]);
      removed++;
    } else FAIL(`could not remove ${wt.path}`);
  }
  gitOk(root, ['worktree', 'prune']);
  if (!dryRun) log(`${name}: removed ${removed} worktrees; kept ${kept} finished ones with uncommitted or unpushed work; ${parseWorktrees(git(root, ['worktree', 'list', '--porcelain'])).length} left`);
  return fail;
}

export function upkeep({ dryRun = false, log = console.log, entries = readRegistry(), clientFor = createClient } = {}) {
  if (!entries.length) {
    log('tug upkeep: no repos registered (run tug setup in each repo)');
    return 0;
  }
  let fail = 0;
  for (const entry of entries) {
    fail |= upkeepRepo(entry, { dryRun, log, clientFor });
    if (existsSync(entry.root)) {
      let client = null;
      try {
        client = clientFor(entry.slug);
      } catch { /* doctor reports not checked */ }
      const results = doctorChecks({ root: entry.root, client });
      log(`doctor ${basename(entry.root)}:\n${formatDoctor(results).replace(/^/gm, '  ')}`);
      if (results.some(r => r.ok === false)) fail = 1;
    }
  }
  return fail;
}
