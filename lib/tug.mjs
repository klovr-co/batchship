#!/usr/bin/env node
// Part of tug. `tug init` copies this file into .agents/tug/; edit it in the tug repo, not there.
// The everyday commands, runnable from a clone without tug installed: `node .agents/tug/tug.mjs ship|guard`.
// An installed `tug ship` / `tug guard` runs this same code. init, doctor, setup and upkeep need tug itself.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { git } from './git.mjs';
import { createClient, repoInfo } from './gh.mjs';
import { guardMain } from './guard.mjs';
import { EXIT, ship } from './ship.mjs';
import { acquireShipLock, findShipState, formatStatus, recordSessionPr, sessionFromEnv, shipReporter } from './state.mjs';
import { VERSION } from './version.mjs';

export const RUNTIME_USAGE = `tug ${VERSION} (the repo's copy in .agents/tug/; the same as an installed tug)

  node .agents/tug/tug.mjs ship <pr> [--now] [--background]
                          queue the PR with Mergify, re-queue after pushes, wait for merge and deploy.
                          --background: progress goes to .agents/state/ship-<pr>.json, one result line at the end
                          (start it in a background shell: you are woken when it exits)
  node .agents/tug/tug.mjs ship --status <pr>
                          the last state of ship <pr> on this machine, without waiting
  node .agents/tug/tug.mjs guard [--hook claude|codex]
                          turn-end check (the repo's .claude/settings.json and .codex/hooks.json run it)

init, setup, doctor and upkeep need tug installed: https://github.com/klovr-co/tug

ship exit codes: 0 merged and deployed · 2 refused (hold, needs-owner, closed, wrong base, hotfix taken)
                 3 out of the queue (fix and push) · 4 deploy failed · 5 timed out · 1 error`;

export const RUNTIME_FLAGS = { ship: ['--now', '--background', '--status'], guard: ['--hook'] };

/** A PR number as typed: digits only, no sign, no leading zero, no '#'. */
export const isPrNumber = text => /^[1-9][0-9]*$/.test(String(text));

/** ship and guard, after the flags were checked. Returns an exit code. */
export async function runtimeCommand(command, rest, { cwd = process.cwd() } = {}) {
  const flags = new Set(rest.filter(a => a.startsWith('--')));
  const args = rest.filter(a => !a.startsWith('--'));
  if (command === 'ship') {
    if (args.length !== 1 || !isPrNumber(args[0]) || (flags.has('--status') && flags.size > 1)) {
      console.error('usage: tug ship <pr> [--now] [--background]   or   tug ship --status <pr>   (<pr> is the PR number, e.g. 1333)');
      return 1;
    }
    const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
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
    if ((flags.has('--hook') && (!['claude', 'codex'].includes(hook) || args.length !== 1)) || (!flags.has('--hook') && args.length)) {
      console.error('usage: tug guard [--hook claude|codex]');
      return 1;
    }
    return guardMain({ hook });
  }
  return 1;
}

/** The vendored CLI: ship, guard, --version, help. */
export async function runtimeMain(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(RUNTIME_USAGE);
    return command ? 0 : 1;
  }
  if (command === '--version' || command === 'version') {
    console.log(VERSION);
    return 0;
  }
  if (!RUNTIME_FLAGS[command]) {
    console.error(`tug: ${command} is not in the repo's copy (only ship and guard are). ${['init', 'setup', 'doctor', 'upkeep'].includes(command) ? `tug ${command} needs tug installed: https://github.com/klovr-co/tug` : ''}\n\n${RUNTIME_USAGE}`);
    return 1;
  }
  const unknown = rest.filter(a => a.startsWith('--') && !RUNTIME_FLAGS[command].includes(a));
  if (unknown.length) {
    console.error(`tug ${command}: unknown option ${unknown.join(', ')}`);
    return 1;
  }
  return runtimeCommand(command, rest);
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
  runtimeMain().then(
    code => { process.exitCode = code; },
    e => {
      console.error(`tug: ${e.message ?? e}`);
      process.exitCode = EXIT.error;
    },
  );
}
