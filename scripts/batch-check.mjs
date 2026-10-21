#!/usr/bin/env node
// Local stand-in for CI. Runs the checks from .ship.json that apply to files changed since the merge base.
// Usage: batch-check.mjs [--quick]   On success writes HEAD sha to .git/batchship-check.
import { execSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';

export function selectChecks(changed, checks, { quick = false } = {}) {
  return checks.filter((c) => (!quick || c.quick) && (!c.paths?.length || changed.some((f) => c.paths.some((p) => f.startsWith(p)))));
}

// soloPaths (e.g. .github/) ship in a batch of their own: mixing them with other changes fails the check.
export function soloMix(changed, soloPaths = []) {
  const solo = changed.filter((f) => soloPaths.some((p) => f.startsWith(p)));
  return solo.length && solo.length < changed.length ? solo : null;
}

const git = (a) => execSync(`git ${a}`, { encoding: 'utf8' }).trim();

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const quick = process.argv.includes('--quick');
  if (!config.checks.length) { console.error('No checks in .ship.json'); process.exit(2); }
  const mb = git(`merge-base HEAD origin/${config.protectedBranch}`);
  const changed = git(`diff --name-only ${mb}`).split('\n').filter(Boolean);
  const mix = soloMix(changed, config.soloPaths);
  if (mix) { console.error(`FAILED: ${mix.join(', ')} must ship in a batch of their own (soloPaths). Move them: node .batchship/triage.mjs new <name>`); process.exit(1); }
  const picked = selectChecks(changed, config.checks, { quick });
  for (const c of picked) {
    console.log(`\n== ${c.name}: ${c.cmd}`);
    if (spawnSync(c.cmd, { shell: true, stdio: 'inherit', cwd: c.cwd || process.cwd() }).status !== 0) { console.error(`FAILED: ${c.name}`); process.exit(1); }
  }
  if (!quick) writeFileSync(git('rev-parse --git-path batchship-check'), git('rev-parse HEAD'));
  console.log(`\nbatch-check passed (${picked.length} checks${quick ? ', quick: marker not written' : ''})`);
}
