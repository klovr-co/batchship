#!/usr/bin/env node
// tug: one delivery flow for every repo. See README.md.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { doctorChecks, formatDoctor } from '../lib/doctor.mjs';
import { git } from '../lib/git.mjs';
import { createClient, repoInfo } from '../lib/gh.mjs';
import { guardMain } from '../lib/guard.mjs';
import { applyInit } from '../lib/init.mjs';
import { setup } from '../lib/setup.mjs';
import { EXIT, ship } from '../lib/ship.mjs';
import { acquireShipLock, findShipState, formatStatus, recordSessionPr, sessionFromEnv, shipReporter } from '../lib/state.mjs';
import { upkeep } from '../lib/upkeep.mjs';
import { VERSION } from '../lib/version.mjs';

const USAGE = `tug ${VERSION}: one delivery flow for every repo

  tug ship <pr> [--now] [--background]
                          queue the PR with Mergify, re-queue after pushes, wait for merge and deploy.
                          --background: progress goes to .agents/state/ship-<pr>.json, one result line at the end
                          (start it in a background shell: you are woken when it exits)
  tug ship --status <pr>  the last state of tug ship <pr> on this machine, without waiting
  tug init [--dry-run] [--force]
                          write the kit into this repo as one PR; create labels; set the default branch
  tug setup               per machine: turn on the pre-push gate, gh needs-me alias, register for upkeep
  tug doctor              report what is set up and what is not (changes nothing)
  tug upkeep [--dry-run]  fast-forward root checkouts, remove finished worktrees, then doctor
  tug guard [--hook claude|codex]
                          turn-end check: exits 1 with one reason when a queued PR is not live and no tug ship
                          follows it, or the last message asks a question no needs-owner PR carries

ship exit codes: 0 merged and deployed · 2 refused (hold, needs-owner, closed, wrong base, hotfix taken)
                 3 out of the queue (fix and push) · 4 deploy failed · 5 timed out · 1 error`;

/** A PR number as typed: digits only, no sign, no leading zero, no '#'. */
export const isPrNumber = text => /^[1-9][0-9]*$/.test(String(text));

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter(a => a.startsWith('--')));
  const args = rest.filter(a => !a.startsWith('--'));
  const known = { ship: ['--now', '--background', '--status'], init: ['--dry-run', '--force'], setup: [], doctor: [], upkeep: ['--dry-run'], guard: ['--hook'] };
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (command === '--version' || command === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (!known[command]) {
    console.error(`tug: unknown command ${command}\n\n${USAGE}`);
    return 1;
  }
  const unknown = [...flags].filter(f => !known[command].includes(f));
  if (unknown.length) {
    console.error(`tug ${command}: unknown option ${unknown.join(', ')}`);
    return 1;
  }

  if (command === 'ship') {
    if (args.length !== 1 || !isPrNumber(args[0]) || (flags.has('--status') && flags.size > 1)) {
      console.error('usage: tug ship <pr> [--now] [--background]   or   tug ship --status <pr>   (<pr> is the PR number, e.g. 1333)');
      return 1;
    }
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    const number = Number(args[0]);
    if (flags.has('--status')) {
      const { code, text } = formatStatus(number, findShipState(root, number));
      console.log(text);
      return code;
    }
    return shipCommand({ root, number, now: flags.has('--now'), background: flags.has('--background') });
  }
  if (command === 'guard') {
    const hook = flags.has('--hook') ? args[0] : null;
    if ((flags.has('--hook') && !['claude', 'codex'].includes(hook)) || (!flags.has('--hook') && args.length)) {
      console.error('usage: tug guard [--hook claude|codex]');
      return 1;
    }
    return guardMain({ hook });
  }
  if (command === 'init') return applyInit({ dryRun: flags.has('--dry-run'), force: flags.has('--force') });
  if (command === 'setup') return setup();
  if (command === 'doctor') {
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    let client = null;
    try {
      client = createClient(repoInfo(root).slug);
    } catch { /* gh unavailable: doctor says not checked */ }
    const results = doctorChecks({ root, client });
    console.log(formatDoctor(results));
    return results.some(r => r.ok === false) ? 1 : 0;
  }
  if (command === 'upkeep') return upkeep({ dryRun: flags.has('--dry-run') });
  return 1;
}

/**
 * tug ship with its state file: progress, heartbeat and result in .agents/state/ship-<pr>.json, and the PR recorded
 * for the agent's session. client, config, workflowFiles, sleep and clock are injectable (tests).
 */
export async function shipCommand({ root, number, now = false, background = false, env = process.env, client, config, workflowFiles, sleep: baseSleep = ms => new Promise(r => setTimeout(r, ms)), clock = Date.now, out = console.log, err = console.error }) {
  const session = sessionFromEnv(env);
  // One run per PR: a second one would race the first on the PR and overwrite its result.
  const lock = acquireShipLock(root, number, { now: clock() });
  if (!lock.ok) {
    const line = `tug ship #${number}: already shipping #${number} (pid ${lock.pid})`;
    const next = `wait for that run (tug ship --status ${number}); you are woken when it exits`;
    out(background ? `${line} · next: ${next}` : line);
    if (!background) out(`next: ${next}`);
    return EXIT.refused;
  }
  try {
    return await shipLocked({ root, number, now, background, session, client, config, workflowFiles, baseSleep, clock, out, err });
  } finally {
    lock.release();
  }
}

async function shipLocked({ root, number, now, background, session, client, config, workflowFiles, baseSleep, clock, out, err }) {
  const reporter = shipReporter({ root, number, session, clock });
  const record = queued => {
    try {
      if (session) recordSessionPr(root, session, { number, queued, clock });
    } catch { /* state is a convenience */ }
  };
  record(false);
  const log = text => {
    reporter.log(text);
    if (!background) err(`  ${text}`);
  };
  // Sleep in steps of at most a minute and refresh the heartbeat, so tug guard can tell a live run from a dead one.
  const sleep = async ms => {
    for (let left = ms; left > 0; left -= 60_000) {
      await baseSleep(Math.min(left, 60_000));
      reporter.beat();
    }
  };
  let result;
  try {
    const cfg = config ?? loadConfig(root);
    const c = client ?? createClient(repoInfo(root).slug);
    const files = workflowFiles ?? (existsSync(join(root, '.github/workflows')) ? readdirSync(join(root, '.github/workflows')) : []);
    result = await ship({ client: c, number, now, config: cfg, workflowFiles: files, log, sleep, clock, onQueued: () => record(true) });
  } catch (e) {
    result = { code: EXIT.error, line: `tug ship #${number}: ${String(e.message || e).split('\n')[0]}`, next: 'fix that, then run tug ship again' };
  }
  reporter.finish(result);
  if (background) out(`${result.line}${result.next ? ` · next: ${result.next}` : ''}`);
  else {
    out(result.line);
    if (result.next) out(`next: ${result.next}`);
  }
  return result.code;
}

const invoked = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) {
  main().then(
    code => { process.exitCode = code; },
    err => {
      console.error(`tug: ${err.message ?? err}`);
      process.exitCode = EXIT.error;
    },
  );
}
