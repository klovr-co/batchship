#!/usr/bin/env node
// PreToolUse hook (Bash, Edit, Write). It stops agents from taking a wrong step by mistake; it is not a security boundary against
// a process set on getting around it. Silent in repos without .ship.json. Dry run: guardMode "warn" in .ship.json only reports.
// Revert: set guardMode to "warn", or remove the hook entry in hooks/hooks.json.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findRoot, loadConfig, withLivePolicy } from './config.mjs';
import { unlocked as unlockedFor, usesMergify } from './lib.mjs';

const isBatchBranch = (b, c) => [...c.batchPrefixes, ...c.hotfixPrefixes].some((p) => b.startsWith(p));

const triageFirst = (b, cmd) => `You are on ${b}, a live branch: do not edit or commit here. Start a fix: ${cmd('fix.mjs')} start <name> `
  + `(it joins today's batch) and work in the printed worktree. An urgent production bug the user calls a hotfix: ${cmd('triage.mjs')} hotfix <name>.`;

// branchOf/headOf/markerOf(dir) read the git state of the directory a command runs in; tests may pass fixed values instead.
// unlocked: what the user asked for in this session ('hotfix', 'ship'), recorded from their own prompt by intent.mjs.
// cmd(script): how to run a batchship script here (the repo's .batchship copy, or the plugin's when the repo has none yet).
// mergify: the repo merges into the live branch through the Mergify queue, so nobody merges those PRs by hand.
export function evaluate({ command = '', filePath, cwd = '.', branch, branchOf = () => branch, head, headOf = () => head, marker, markerOf = () => marker,
  config, unlocked = new Set(), cmd = (f) => `node .batchship/${f}`, mergify = false, repo = '' }) {
  const out = [];
  const prot = config.protectedBranch;
  const manual = config.manualBranches || [];
  const live = [prot, ...manual];
  const isShip = (b) => config.batchPrefixes.some((p) => b.startsWith(p));
  if (filePath) {
    if (/batchship-unlock/.test(filePath)) return ['Only the user unlocks hotfix / ship, by asking for it in the session.'];
    const b = branchOf(dirname(filePath));
    return live.includes(b) ? [triageFirst(b, cmd)] : [];
  }
  // dir is null once a cd target cannot be worked out (loop variables, $(...)): then branch-based rules stay quiet.
  let dir = cwd;
  const vars = {};
  const where = (p) => {
    const x = p.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, v) => vars[v] ?? m);
    return dir && !/[$`*]/.test(x) ? resolve(dir, x) : null;
  };
  if (/batchship-un|\bnode\b[^|;&\n]*\bintent\.mjs\b|\|\s*node\b[^|;&\n]*intent\.mjs/.test(command)) out.push('Only the user unlocks hotfix / ship, by asking for it in the session.');
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
    if (/^git\s+commit\b/.test(seg) && live.includes(branch)) out.push(triageFirst(branch, cmd));
    if (/^git\s+push\b/.test(seg) && (/BATCHSHIP_ALLOW/.test(raw) || /--no-verify\b/.test(seg)))
      out.push('Do not bypass the push guard (BATCHSHIP_ALLOW / --no-verify); that override is for a human.');
    else if (/BATCHSHIP_ALLOW/.test(raw)) out.push('BATCHSHIP_ALLOW is the human\'s override; agents do not set it.');
    if (/^git\s+push\b/.test(seg)) {
      const hit = [prot, ...manual].find((g) => new RegExp(`(\\s|:|\\/)${g}(\\s|$)`).test(seg) || (/^git\s+push\s*$/.test(seg) && branch === g));
      if (hit) out.push(manual.includes(hit) ? `${hit} is handled manually by a human; do not push to it.` : `Do not push to ${hit}. Fixes go through ${cmd('fix.mjs')} done; urgent ones through a hotfix PR.`);
      // Batches change only through fix.mjs done (reviewed fixes) and ship.mjs, never by a direct push.
      const refs = seg.split(/\s+/).slice(2).filter((w) => !w.startsWith('-')).slice(1); // after the remote name
      const dests = refs.length ? refs.map((r) => r.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '')).map((d) => (d === 'HEAD' ? branch : d)) : [branch];
      if (!/\s--delete\b|\s-d\s/.test(seg) && dests.some((d) => d && isShip(d)))
        out.push(`Batch branches change only through ${cmd('fix.mjs')} done and ${cmd('ship.mjs')}; push your fix branch instead.`);
    }
    // gh pr ... -R owner/name aimed at another repository: this repo's rules do not apply to it.
    const other = /^gh\s+pr\b/.test(seg) && (seg.match(/(?:\s-R|\s--repo)[=\s]+(\S+)/) || [])[1];
    if (other && repo && other.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').toLowerCase() !== repo.toLowerCase()) continue;
    if (/review\.mjs\b.*--force\b/.test(seg)) out.push('Only the human re-opens review (--force). Stop and hand the fix over with the open findings.');
    // Each unlock opens only its own path: "hotfix" for hotfix/* branches, "ship" for batches.
    const may = (b) => (b && config.hotfixPrefixes.some((p) => b.startsWith(p)) ? unlocked.has('hotfix') : b && isShip(b) ? unlocked.has('ship') : false);
    if (/ship\.mjs\b.*--merge\b/.test(seg) && !unlocked.has('ship')) out.push('ship.mjs --merge needs the user to ask for it ("ship when done", "then ship"). Otherwise plain ship.mjs opens the batch PR as a draft.');
    // Marking ready and merging are the human's, unless the user asked for a hotfix or to ship in this session.
    const act = /^gh\s+pr\s+(ready|merge)\b/.exec(seg)?.[1];
    if (act && /--admin\b/.test(seg)) out.push('Do not use --admin: merge only through the normal checks.');
    else if (act === 'merge' && mergify) out.push(`The Mergify queue merges PRs into ${prot}: batches are queued by ${cmd('ship.mjs')}; a hotfix the user asked for: gh pr ready, then gh pr comment <PR> --body '@mergifyio queue'.`);
    else if (act && !may(branch)) out.push(unlocked.size ? `With "${[...unlocked].join('", "')}" from the user, gh pr ${act} works only from the ${unlocked.has('hotfix') ? 'hotfix' : 'batch'} worktree it is for (here: ${branch || 'unknown'}).` : act === 'ready'
      ? 'Marking a PR ready starts CI (the paid step): leave it to the human, unless they ask for a hotfix or to ship. Batches ship with ship.mjs.'
      : 'Merging is the human\'s, unless they ask for a hotfix or to ship. Fixes merge into batches through fix.mjs done.');
    if (/^gh\s+pr\s+create\b/.test(seg)) {
      const base = (seg.match(/(?:--base|-B)[=\s]+(\S+)/) || [])[1];
      if (base && isShip(base)) continue; // a fix PR into a batch: no CI on ship/*
      const draft = /(--draft|\s-d)(\s|$)/.test(seg);
      if (!base && manual.length) { out.push(`Pass --base ${prot} explicitly; the repo default may be ${manual.join('/')}, which is handled manually.`); continue; }
      const target = base || prot;
      if (manual.includes(target)) { out.push(`${target} is handled manually by a human; do not open PRs to it (use --base ${prot}).`); continue; }
      if (target !== prot) continue;
      if (!draft && !may(branch)) out.push('Open the PR as a draft (--draft); a non-draft PR starts CI immediately. (A hotfix the user asked for may be opened ready.)');
      if (!known) continue;
      if (!isBatchBranch(branch, config))
        out.push(`PR to ${prot} must come from ${config.batchPrefixes.join(', ')} or ${config.hotfixPrefixes.join(', ')} (now: ${branch}). Fixes go into today's batch: ${cmd('fix.mjs')} start <name>.`);
      else if (isShip(branch) && markerOf(segDir) !== headOf(segDir))
        out.push(`No passing batch-check for HEAD. Batches open their PR with ${cmd('ship.mjs')}.`);
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
  // Push, PR and review rules use the live branch's policy; the batch's own .ship.json could have switched them off.
  const config = /\bgit\b[\s\S]*\bpush\b|\bgh\s+pr\b|review\.mjs/.test(command) ? withLivePolicy(root, loadConfig(root)) : loadConfig(root);
  const branchOf = (d) => git('rev-parse --abbrev-ref HEAD', existing(d));
  const headOf = (d) => git('rev-parse HEAD', existing(d));
  const markerOf = (d) => {
    const p = git('rev-parse --git-path batchship-check', existing(d));
    return p && existsSync(resolve(existing(d), p)) ? readFileSync(resolve(existing(d), p), 'utf8').trim() : '';
  };
  // Repos set up before a script existed have no .batchship copy of it: point at this plugin's.
  const cmd = (f) => (existsSync(resolve(root, '.batchship', f)) ? `node .batchship/${f}` : `node "${resolve(import.meta.dirname, f)}"`);
  let unlocked = new Set();
  try { unlocked = unlockedFor(root, input.session_id ?? 'none'); } catch {}
  const repo = (git('remote get-url origin', root).match(/github\.com[:/](.+?)(?:\.git)?$/) || [])[1] || '';
  const problems = evaluate({ command, filePath, cwd, branchOf, headOf, markerOf, config, unlocked, cmd, mergify: usesMergify(root, config), repo });
  // A repo whose .batchship copy is older than this plugin gets one line saying so.
  const v = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')).version; } catch { return ''; } };
  const mine = v(resolve(import.meta.dirname, '../plugin.json')), theirs = existsSync(resolve(root, '.batchship/VERSION')) ? readFileSync(resolve(root, '.batchship/VERSION'), 'utf8').trim() : '0';
  if (problems.length && mine && theirs !== mine) problems.push(`(This repo's batchship scripts are ${theirs}, the plugin is ${mine}: refresh them with init.mjs --update in a fix.)`);
  if (problems.length) console.log(JSON.stringify(formatOutput(agent, `batchship: ${problems.join(' ')}`, config.guardMode === 'block')));
  else if (agent === 'agy') console.log(JSON.stringify({ decision: 'allow' }));
}
