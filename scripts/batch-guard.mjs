#!/usr/bin/env node
// PreToolUse hook (Bash, Edit, Write). Silent in repos without .ship.json. Dry run: guardMode "warn" in .ship.json only reports.
// Revert: set guardMode to "warn", or remove the hook entry in hooks/hooks.json.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findRoot, loadConfig } from './config.mjs';

const isBatchBranch = (b, c) => [...c.batchPrefixes, ...c.hotfixPrefixes].some((p) => b.startsWith(p));

const triageFirst = (b, t) => `You are on ${b}, a live branch: do not edit or commit here. Triage first: ${t} list, `
  + 'then join <batch> or new <name>, and do the work in the printed worktree (or hand it to a worker there).';

// branchOf/headOf/markerOf/reviewOf(dir) read the git state of the directory a command runs in; tests may pass fixed values instead.
export function evaluate({ command = '', filePath, cwd = '.', branch, branchOf = () => branch, head, headOf = () => head, marker, markerOf = () => marker, review, reviewOf = () => review, config, triage = 'node .batchship/triage.mjs' }) {
  const out = [];
  const prot = config.protectedBranch;
  const manual = config.manualBranches || [];
  const live = [prot, ...manual];
  if (filePath) {
    const b = branchOf(dirname(filePath));
    return live.includes(b) ? [triageFirst(b, triage)] : [];
  }
  // dir is null once a cd target cannot be worked out (loop variables, $(...)): then branch-based rules stay quiet.
  let dir = cwd;
  const vars = {};
  const where = (p) => {
    const x = p.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, v) => vars[v] ?? m);
    return dir && !/[$`*]/.test(x) ? resolve(dir, x) : null;
  };
  const segments = command.split(/&&|\|\||;|\n/).map((s) => s.trim().replace(/^[({]\s*/, ''));
  for (const raw of segments) {
    const assign = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)$/);
    if (assign) { vars[assign[1]] = assign[2].replace(/^["']|["']$/g, ''); continue; }
    let seg = raw.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''); // drop leading VAR=value prefixes
    const cd = seg.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/);
    if (cd) { dir = where(cd[1] || cd[2] || cd[3]); continue; }
    let segDir = dir;
    seg = seg.replace(/^git\s+-C\s+(?:"([^"]+)"|(\S+))/, (_, q, p) => { segDir = where(q || p); return 'git'; });
    branch = segDir ? branchOf(segDir) : '';
    const known = !!branch;
    if (/^git\s+commit\b/.test(seg) && live.includes(branch)) out.push(triageFirst(branch, triage));
    if (/^git\s+push\b/.test(seg) && (/BATCHSHIP_ALLOW/.test(raw) || /--no-verify\b/.test(seg)))
      out.push('Do not bypass the push guard (BATCHSHIP_ALLOW / --no-verify); that override is for a human.');
    if (/^git\s+push\b/.test(seg)) {
      const hit = [prot, ...manual].find((g) => new RegExp(`(\\s|:|\\/)${g}(\\s|$)`).test(seg) || (/^git\s+push\s*$/.test(seg) && branch === g));
      if (hit) out.push(manual.includes(hit) ? `${hit} is handled manually by a human; do not push to it.` : `Do not push to ${hit}. Work on ${config.batchPrefixes[0]}NAME and open a PR.`);
    }
    // Each fix is reviewed as it lands on the batch: pushing a batch branch needs a passing review for HEAD.
    if (/^git\s+push\b/.test(seg) && known && config.review?.reviewers?.length && config.batchPrefixes.some((p) => branch.startsWith(p))) {
      const r = reviewOf(segDir);
      if (!(r?.pass && r.head === headOf(segDir))) out.push('Review before pushing to the batch: node .batchship/review.mjs, then fix blocker/major findings.');
    }
    // Marking ready and merging are the paid / release steps: human only, unless review.after is 'merge' and this batch passed check and review.
    const ship = /^gh\s+pr\s+(ready|merge)\b/.exec(seg)?.[1];
    if (ship && config.review?.after === 'merge') {
      const h = segDir ? headOf(segDir) : '';
      const r = segDir ? reviewOf(segDir) : null;
      if (!known || !isBatchBranch(branch, config)) out.push(`Run gh pr ${ship} from inside the batch worktree (${config.batchPrefixes[0]}*), so the guard can see its review.`);
      else if (markerOf(segDir) !== h) out.push('No passing batch-check for HEAD. Run: node .batchship/batch-check.mjs');
      else if (!(r?.pass && r.head === h)) out.push('No passing review for HEAD. Run: node .batchship/review.mjs, fix blocker/major findings, then retry.');
    } else if (ship === 'ready') out.push('Marking a PR ready starts CI (the paid step). Leave it as a draft and ask the human to mark it ready.');
    else if (ship === 'merge') out.push('Agents do not merge PRs. The human merges.');
    if (/^gh\s+pr\s+create\b/.test(seg) && !/(--draft|\s-d)(\s|$)/.test(seg)) out.push('Open the PR as a draft (--draft); a non-draft PR starts CI immediately.');
    if (/^gh\s+pr\s+create\b/.test(seg)) {
      const base = (seg.match(/(?:--base|-B)[=\s]+(\S+)/) || [])[1];
      if (!base && manual.length) { out.push(`Pass --base ${prot} explicitly; the repo default may be ${manual.join('/')}, which is handled manually.`); continue; }
      const target = base || prot;
      if (manual.includes(target)) { out.push(`${target} is handled manually by a human; do not open PRs to it (use --base ${prot}).`); continue; }
      if (target !== prot) continue;
      if (!known) continue;
      if (!isBatchBranch(branch, config))
        out.push(`PR to ${prot} must come from ${config.batchPrefixes.join(', ')} or ${config.hotfixPrefixes.join(', ')} (now: ${branch}).`);
      else if (!config.hotfixPrefixes.some((p) => branch.startsWith(p)) && markerOf(segDir) !== headOf(segDir))
        out.push('No passing batch-check for HEAD. Run: node .batchship/batch-check.mjs (see /ship-batch check).');
    }
  }
  return out;
}

function git(args, cwd = process.cwd()) { try { return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }

// Claude Code: {tool_input:{command | file_path | notebook_path}, cwd}. Antigravity (agy): {toolCall:{args:{CommandLine,Cwd}}, workspacePaths}.
export function parseInput(input) {
  if (input.toolCall) {
    const a = input.toolCall.args || {};
    return { agent: 'agy', command: a.CommandLine || '', cwd: a.Cwd || input.workspacePaths?.[0] || process.cwd() };
  }
  const t = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const file = t.file_path || t.notebook_path;
  return { agent: 'claude', command: t.command || '', cwd, ...(file && { filePath: resolve(cwd, file) }) };
}

// Nearest directory that exists (a Write may create new folders).
const existing = (d) => { while (!existsSync(d) && dirname(d) !== d) d = dirname(d); return d; };

export function formatOutput(agent, msg, block) {
  if (agent === 'agy') return { decision: block ? 'deny' : 'allow', reason: block ? msg : `WARNING (will block later): ${msg}` };
  return { hookSpecificOutput: block
    ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg }
    : { hookEventName: 'PreToolUse', additionalContext: `WARNING (will block later): ${msg}` } };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  const { agent, command, cwd, filePath } = parseInput(input);
  const root = findRoot(existing(filePath ? dirname(filePath) : cwd));
  if (!root) { if (agent === 'agy') console.log(JSON.stringify({ decision: 'allow' })); process.exit(0); }
  const config = loadConfig(root);
  const branchOf = (d) => git('rev-parse --abbrev-ref HEAD', existing(d));
  const headOf = (d) => git('rev-parse HEAD', existing(d));
  const markerOf = (d) => {
    const p = git('rev-parse --git-path batchship-check', existing(d));
    return p && existsSync(resolve(existing(d), p)) ? readFileSync(resolve(existing(d), p), 'utf8').trim() : '';
  };
  const reviewOf = (d) => {
    const p = git('rev-parse --git-path batchship-review.json', existing(d));
    try { return JSON.parse(readFileSync(resolve(existing(d), p), 'utf8')); } catch { return null; }
  };
  // Repos set up before triage existed have no .batchship/triage.mjs: point at this plugin's copy.
  const triage = existsSync(resolve(root, '.batchship/triage.mjs')) ? 'node .batchship/triage.mjs' : `node "${resolve(import.meta.dirname, 'triage.mjs')}"`;
  const problems = evaluate({ command, filePath, cwd, branchOf, headOf, markerOf, reviewOf, config, triage });
  if (problems.length) console.log(JSON.stringify(formatOutput(agent, `batchship: ${problems.join(' ')}`, config.guardMode === 'block')));
  else if (agent === 'agy') console.log(JSON.stringify({ decision: 'allow' }));
}
