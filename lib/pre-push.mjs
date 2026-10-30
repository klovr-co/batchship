#!/usr/bin/env node
// Part of shiplane. `shiplane init` copies this file into .agents/shiplane/; edit it in the shiplane repo, not there.
// The pre-push gate. CI runs only on the merge queue's batch, so this is a PR's own check: a red batch is a paid
// CI run and holds back every PR in it. For each commit being pushed it runs, against origin/<ship branch>:
//   1. line endings: no changed file flips CRLF <-> LF or becomes mixed;
//   2. generated files are current (config `generated`), when the pushed commit is checked out;
//   3. the repo's own check (config `checkCommand`), with the hook's stdin passed through.
// Usage: node .agents/shiplane/pre-push.mjs          check HEAD
//        node .agents/shiplane/pre-push.mjs --hook   read the pushed refs from stdin (git's pre-push protocol)
// Never skip it with `git push --no-verify` (AGENTS.md).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkGenerated } from './checks/generated-current.mjs';
import { changedFiles, checkLineEndings } from './checks/line-endings.mjs';
import { loadConfig, needsOwnerMatches, shipBranch } from './config.mjs';
import { cleanEnv, git, gitOk, tryGit, ZERO_SHA } from './git.mjs';
import { depsMissing, fsReader, repoInstallCommand } from './pm.mjs';

/**
 * The commits a push sends, from git's pre-push stdin ("<local ref> <local sha> <remote ref> <remote sha>" lines).
 * Skips only deletes (zero local sha) and tags (remote ref under refs/tags/). Every other push is checked,
 * including `git push origin HEAD:branch` and `git push origin <sha>:refs/heads/x`, whose local ref is not a branch.
 */
export function parsePushLines(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text).split('\n')) {
    const [localRef, localSha, remoteRef] = line.trim().split(/\s+/);
    if (!localSha || !remoteRef) continue;
    if (ZERO_SHA.test(localSha)) continue; // a delete
    if (remoteRef.startsWith('refs/tags/')) continue;
    if (seen.has(localSha)) continue;
    seen.add(localSha);
    out.push({ sha: localSha, label: remoteRef.replace(/^refs\/heads\//, ''), localRef });
  }
  return out;
}

function runShell(command, { cwd, input, env }) {
  const started = Date.now();
  const result = spawnSync('sh', ['-c', command], { cwd, env, input: input ?? '', stdio: ['pipe', 'inherit', 'inherit'] });
  return { code: result.status ?? 1, seconds: (Date.now() - started) / 1000 };
}

/**
 * Run the gate. Returns { ok, failures: [{ name, message }] }. `log`/`error` print progress.
 * Options: root, hookInput (stdin text or null for "check HEAD"), config (default: the repo's).
 */
export function runPrePush({ root, hookInput = null, config = loadConfig(root), log = console.log, error = console.error, runCheckCommand = true }) {
  const branch = shipBranch(config);
  const baseRef = `refs/remotes/origin/${branch}`;
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const targets = hookInput === null || !hookInput.trim() ? [{ sha: head, label: 'HEAD' }] : parsePushLines(hookInput);
  const failures = [];
  const fail = (name, message) => { failures.push({ name, message }); error(`  FAIL  ${name}\n${message.replace(/^/gm, '        ')}`); };
  const ok = message => log(`  ok    ${message}`);
  const skip = message => log(`  skip  ${message}`);
  if (!targets.length) {
    log('shiplane pre-push: only deletes or tags, nothing to check');
    return { ok: true, failures };
  }
  if (!gitOk(root, ['rev-parse', '--verify', '--quiet', baseRef])) {
    fail('Compare with the ship branch', `No origin/${branch} to compare with. Run \`git fetch origin ${branch}\` and push again.`);
    return { ok: false, failures };
  }
  let checkHead = false;
  for (const { sha, label } of targets) {
    if (gitOk(root, ['merge-base', '--is-ancestor', sha, baseRef])) {
      log(`shiplane pre-push: ${label} is already on origin/${branch}, nothing to check`);
      continue;
    }
    const base = tryGit(root, ['merge-base', baseRef, sha]);
    if (!base) {
      fail(`${label}`, `${sha.slice(0, 10)} shares no history with origin/${branch}; nothing to compare it with.`);
      continue;
    }
    const changes = changedFiles(root, base, sha);
    log(`shiplane pre-push: ${label} ${sha.slice(0, 10)}, ${changes.length} file(s) changed against origin/${branch}`);
    const endings = checkLineEndings({ cwd: root, base, sha, changes });
    if (endings.ok) ok('line endings unchanged');
    else fail('Line endings unchanged', endings.message);
    const owner = needsOwnerMatches(config, changes.map(c => c.file));
    if (owner.length) log(`  note  ${owner.length} file(s) match needsOwner (${owner.slice(0, 3).join(', ')}${owner.length > 3 ? ', ...' : ''}): label the PR needs-owner unless the user already said yes`);
    if (sha === head) checkHead = true;
    else if (config.generated.length || config.checkCommand) skip(`generated files and checkCommand for ${label}: ${sha.slice(0, 10)} is not checked out (HEAD is ${head.slice(0, 10)}); not checked. Push from the branch you push.`);
  }
  if (checkHead) {
    for (const { run } of config.generated) {
      const result = checkGenerated({ cwd: root, run });
      if (result.ok) ok(result.message);
      else fail('Generated files current', `${result.message}${result.output.trim() ? `\n${result.output.trim().split('\n').slice(-20).join('\n')}` : ''}`);
    }
    if (config.checkCommand && runCheckCommand) {
      log(`shiplane pre-push: ${config.checkCommand}`);
      const result = runShell(config.checkCommand, { cwd: root, input: hookInput ?? '', env: cleanEnv({ SHIPLANE_BASE_REF: baseRef, SHIPLANE_SHIP_BRANCH: branch }) });
      if (result.code === 0) ok(`checkCommand (${result.seconds.toFixed(1)} s)`);
      else {
        const install = repoInstallCommand(config, fsReader(root));
        const hint = depsMissing(root) && install ? `\nThis checkout has no node_modules (a fresh worktree?): run \`${install}\`, then push again.` : '';
        fail(`checkCommand (exit ${result.code})`, `\`${config.checkCommand}\` failed; its output is above.${hint}`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

async function main() {
  const hook = process.argv.includes('--hook');
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const started = Date.now();
  let hookInput = null;
  if (hook && !process.stdin.isTTY) {
    try {
      hookInput = readFileSync(0, 'utf8');
    } catch {
      hookInput = '';
    }
  }
  const { ok } = runPrePush({ root, hookInput });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (ok) console.log(`shiplane pre-push: passed in ${seconds} s`);
  else console.error(`\nshiplane pre-push: FAILED in ${seconds} s. Fix it, commit, and push again. Never push with --no-verify.`);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => {
    console.error(`shiplane pre-push: ${err.message ?? err}`);
    process.exitCode = 1;
  });
}
