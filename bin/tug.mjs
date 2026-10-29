#!/usr/bin/env node
// tug: one delivery flow for every repo. See README.md.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { doctorChecks, formatDoctor } from '../lib/doctor.mjs';
import { git } from '../lib/git.mjs';
import { createClient, repoInfo } from '../lib/gh.mjs';
import { applyInit } from '../lib/init.mjs';
import { setup } from '../lib/setup.mjs';
import { EXIT, ship } from '../lib/ship.mjs';
import { upkeep } from '../lib/upkeep.mjs';
import { VERSION } from '../lib/version.mjs';

const USAGE = `tug ${VERSION}: one delivery flow for every repo

  tug ship <pr> [--now]   queue the PR with Mergify, re-queue after pushes, wait for merge and deploy
  tug init [--dry-run] [--force]
                          write the kit into this repo as one PR; create labels; set the default branch
  tug setup               per machine: turn on the pre-push gate, gh needs-me alias, register for upkeep
  tug doctor              report what is set up and what is not (changes nothing)
  tug upkeep [--dry-run]  fast-forward root checkouts, remove finished worktrees, then doctor

ship exit codes: 0 merged and deployed · 2 refused (hold, needs-owner, closed, wrong base, hotfix taken)
                 3 out of the queue (fix and push) · 4 deploy failed · 5 timed out · 1 error`;

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter(a => a.startsWith('--')));
  const args = rest.filter(a => !a.startsWith('--'));
  const known = { ship: ['--now'], init: ['--dry-run', '--force'], setup: [], doctor: [], upkeep: ['--dry-run'] };
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
    const number = Number(String(args[0] || '').replace(/^#/, ''));
    if (!Number.isInteger(number) || number <= 0 || args.length !== 1) {
      console.error('usage: tug ship <pr> [--now]');
      return 1;
    }
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    const config = loadConfig(root);
    const client = createClient(repoInfo(root).slug);
    const out = await ship({ client, number, now: flags.has('--now'), config, log: text => console.error(`  ${text}`) });
    console.log(out.line);
    if (out.next) console.log(`next: ${out.next}`);
    return out.code;
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
