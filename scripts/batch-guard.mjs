#!/usr/bin/env node
// PreToolUse hook (Bash). Dry run: guardMode "warn" in .ship.json only reports.
// Revert: set guardMode to "warn", or remove the hook entry in hooks/hooks.json.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';

const isBatchBranch = (b, c) => [...c.batchPrefixes, ...c.hotfixPrefixes].some((p) => b.startsWith(p));

export function evaluate({ command, branch, head, marker, config }) {
  const out = [];
  const prot = config.protectedBranch;
  const segments = command.split(/&&|\|\||;|\n/).map((s) => s.trim());
  for (const seg of segments) {
    if (/^git\s+push\b/.test(seg)) {
      const toMain = new RegExp(`(\\s|:|\\/)${prot}(\\s|$)`).test(seg) || (/^git\s+push\s*$/.test(seg) && branch === prot);
      if (toMain) out.push(`Do not push to ${prot}. Work on ${config.batchPrefixes[0]}NAME and open a PR.`);
    }
    if (/^gh\s+pr\s+(create|ready)\b/.test(seg)) {
      const base = (seg.match(/(?:--base|-B)[=\s]+(\S+)/) || [])[1] || prot;
      if (base !== prot) continue;
      if (!isBatchBranch(branch, config))
        out.push(`PR to ${prot} must come from ${config.batchPrefixes.join(', ')} or ${config.hotfixPrefixes.join(', ')} (now: ${branch}).`);
      else if (!branch.startsWith(config.hotfixPrefixes[0] || '\0') && marker !== head)
        out.push('No passing batch-check for HEAD. Run: node .batchship/batch-check.mjs (see /ship-batch check).');
    }
  }
  return out;
}

function git(args) { try { return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } }

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  const command = input.tool_input?.command || '';
  const config = loadConfig(input.cwd || process.cwd());
  const markerPath = git('rev-parse --git-path batchship-check');
  const marker = markerPath && existsSync(markerPath) ? readFileSync(markerPath, 'utf8').trim() : '';
  const problems = evaluate({ command, branch: git('rev-parse --abbrev-ref HEAD'), head: git('rev-parse HEAD'), marker, config });
  if (problems.length) {
    const msg = `batchship: ${problems.join(' ')}`;
    const block = config.guardMode === 'block';
    console.log(JSON.stringify({ hookSpecificOutput: block
      ? { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg }
      : { hookEventName: 'PreToolUse', additionalContext: `WARNING (will block later): ${msg}` } }));
  }
}
