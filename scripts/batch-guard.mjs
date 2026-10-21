#!/usr/bin/env node
// PreToolUse hook (Bash). Dry run: guardMode "warn" in .ship.json only reports.
// Revert: set guardMode to "warn", or remove the hook entry in hooks/hooks.json.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';

const isBatchBranch = (b, c) => [...c.batchPrefixes, ...c.hotfixPrefixes].some((p) => b.startsWith(p));

export function evaluate({ command, branch, head, marker, config }) {
  const out = [];
  const prot = config.protectedBranch;
  const manual = config.manualBranches || [];
  const segments = command.split(/&&|\|\||;|\n/).map((s) => s.trim());
  for (const raw of segments) {
    const seg = raw.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''); // drop leading VAR=value prefixes
    if (/^git\s+push\b/.test(seg) && (/BATCHSHIP_ALLOW/.test(raw) || /--no-verify\b/.test(seg)))
      out.push('Do not bypass the push guard (BATCHSHIP_ALLOW / --no-verify); that override is for a human.');
    if (/^git\s+push\b/.test(seg)) {
      const hit = [prot, ...manual].find((g) => new RegExp(`(\\s|:|\\/)${g}(\\s|$)`).test(seg) || (/^git\s+push\s*$/.test(seg) && branch === g));
      if (hit) out.push(manual.includes(hit) ? `${hit} is handled manually by a human; do not push to it.` : `Do not push to ${hit}. Work on ${config.batchPrefixes[0]}NAME and open a PR.`);
    }
    if (/^gh\s+pr\s+(create|ready)\b/.test(seg)) {
      const base = (seg.match(/(?:--base|-B)[=\s]+(\S+)/) || [])[1];
      if (!base && manual.length) { out.push(`Pass --base ${prot} explicitly; the repo default may be ${manual.join('/')}, which is handled manually.`); continue; }
      const target = base || prot;
      if (manual.includes(target)) { out.push(`${target} is handled manually by a human; do not open PRs to it (use --base ${prot}).`); continue; }
      if (target !== prot) continue;
      if (!isBatchBranch(branch, config))
        out.push(`PR to ${prot} must come from ${config.batchPrefixes.join(', ')} or ${config.hotfixPrefixes.join(', ')} (now: ${branch}).`);
      else if (!config.hotfixPrefixes.some((p) => branch.startsWith(p)) && marker !== head)
        out.push('No passing batch-check for HEAD. Run: node .batchship/batch-check.mjs (see /ship-batch check).');
    }
  }
  return out;
}

function git(args, cwd = process.cwd()) { try { return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }

// Claude Code: {tool_input:{command}, cwd}. Antigravity (agy): {toolCall:{args:{CommandLine,Cwd}}, workspacePaths}.
export function parseInput(input) {
  if (input.toolCall) {
    const a = input.toolCall.args || {};
    return { agent: 'agy', command: a.CommandLine || '', cwd: a.Cwd || input.workspacePaths?.[0] || process.cwd() };
  }
  return { agent: 'claude', command: input.tool_input?.command || '', cwd: input.cwd || process.cwd() };
}

export function formatOutput(agent, msg, block) {
  if (agent === 'agy') return { decision: block ? 'deny' : 'allow', reason: block ? msg : `WARNING (will block later): ${msg}` };
  return { hookSpecificOutput: block
    ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg }
    : { hookEventName: 'PreToolUse', additionalContext: `WARNING (will block later): ${msg}` } };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  const { agent, command, cwd } = parseInput(input);
  const config = loadConfig(cwd);
  const markerPath = git('rev-parse --git-path batchship-check', cwd);
  const marker = markerPath && existsSync(join(cwd, markerPath)) ? readFileSync(join(cwd, markerPath), 'utf8').trim() : '';
  const problems = evaluate({ command, branch: git('rev-parse --abbrev-ref HEAD', cwd), head: git('rev-parse HEAD', cwd), marker, config });
  if (problems.length) console.log(JSON.stringify(formatOutput(agent, `batchship: ${problems.join(' ')}`, config.guardMode === 'block')));
  else if (agent === 'agy') console.log(JSON.stringify({ decision: 'allow' }));
}
