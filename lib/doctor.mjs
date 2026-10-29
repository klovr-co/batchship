// tug doctor: is this repo, on this machine, on the delivery flow? Reports; changes nothing (no fetch either:
// "behind" is as of the last fetch, and `tug upkeep` fetches before it runs doctor).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, shipBranch } from './config.mjs';
import { git, tryGit } from './git.mjs';
import { detectHookManager, hookStatus } from './hooks.mjs';
import { LABELS, LOCK_PATH, MERGIFY_PATHS } from './init.mjs';
import { fsReader } from './pm.mjs';
import { agentsBlockVersion, mergifyLeaks } from './render.mjs';
import { VERSION } from './version.mjs';

/** The main worktree (the root checkout) of the repo containing cwd. */
export function mainWorktree(cwd) {
  const out = git(cwd, ['worktree', 'list', '--porcelain']);
  const first = out.split('\n').find(l => l.startsWith('worktree '));
  return first ? first.slice('worktree '.length) : git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

/** Run every check. Returns [{ name, ok: true|false|null, detail }] (null: not checked). */
export function doctorChecks({ root, client }) {
  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });
  const guard = (name, fn) => {
    try {
      fn();
    } catch (err) {
      add(name, null, `not checked: ${String(err.message || err).split('\n')[0]}`);
    }
  };
  let config;
  let branch;
  try {
    config = loadConfig(root);
    branch = shipBranch(config);
    add('config', true, `.agents/config.yml: ship target ${config.shipTarget} = ${branch}`);
  } catch (err) {
    add('config', false, err.message);
    return results;
  }

  guard('labels', () => {
    if (!client) throw new Error('no GitHub client');
    const have = client.labels();
    const missing = LABELS.map(l => l.name).filter(n => !have.includes(n));
    add('labels', !missing.length, missing.length ? `missing: ${missing.join(', ')} (tug init creates them)` : 'queue, hotfix, hold, needs-owner, approved, full-ci');
  });
  guard('default branch', () => {
    if (!client) throw new Error('no GitHub client');
    const current = client.defaultBranch();
    add('default branch', current === branch, current === branch ? `${current} (Mergify reads its config here)` : `${current}, but the ship branch is ${branch}: Mergify reads its config from the default branch (tug init sets it)`);
  });
  guard('pre-push hook', () => {
    const status = hookStatus(root, detectHookManager(fsReader(root)));
    add('pre-push hook', status.ok, `${status.mechanism}: ${status.detail}`);
  });
  guard('AGENTS block', () => {
    const path = join(root, 'AGENTS.md');
    const version = existsSync(path) ? agentsBlockVersion(readFileSync(path, 'utf8')) : null;
    let lock = null;
    try {
      lock = JSON.parse(readFileSync(join(root, LOCK_PATH), 'utf8')).version;
    } catch { /* none */ }
    if (!version) add('AGENTS block', false, 'AGENTS.md has no tug block: run tug init');
    else add('AGENTS block', version === VERSION && (!lock || lock === VERSION), `block v${version}, lock ${lock ? `v${lock}` : 'missing'}, kit v${VERSION}${version === VERSION ? '' : ': run tug init to update'}`);
  });
  guard('mergify', () => {
    const path = MERGIFY_PATHS.find(p => existsSync(join(root, p)));
    if (!path) return add('mergify', false, 'no Mergify config (tug init writes .mergify.yml)');
    const leaks = mergifyLeaks(readFileSync(join(root, path), 'utf8'));
    add('mergify', !leaks.length, leaks.length ? `${path}: ${leaks.map(l => `rule ${l.rule} lets ${l.missing.join(' and ')} in`).join('; ')}` : `${path} blocks hold and needs-owner in every queue rule`);
  });
  guard('root checkout', () => {
    const main = mainWorktree(root);
    const current = tryGit(main, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const behind = Number(tryGit(main, ['rev-list', '--count', `HEAD..refs/remotes/origin/${branch}`]) ?? NaN);
    if (current !== branch) add('root checkout', false, `${main} is on ${current}, not ${branch}`);
    else if (Number.isNaN(behind)) add('root checkout', null, `not checked: no origin/${branch} (fetch first)`);
    else add('root checkout', behind === 0, behind ? `${main} is ${behind} commit(s) behind origin/${branch} as of the last fetch (tug upkeep fast-forwards it)` : `${main} is current with origin/${branch} as of the last fetch`);
  });
  return results;
}

export function formatDoctor(results) {
  return results.map(r => `${r.ok === true ? 'ok  ' : r.ok === false ? 'FAIL' : '--  '}  ${r.name}: ${r.detail}`).join('\n');
}
