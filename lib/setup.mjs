// shiplane setup: once per machine per repo. Turns on the pre-push gate (through the repo's hook manager if it has one),
// adds the `gh needs-me` alias, registers the repo for upkeep, checks tools, and prints the T3 settings to apply.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { loadConfig, shipBranch } from './config.mjs';
import { mainWorktree } from './doctor.mjs';
import { git, tryGit } from './git.mjs';
import { repoInfo } from './gh.mjs';
import { detectHarnesses, guardCommand, installedGuard, installGuard, PROJECT_HOOKS, projectGuard } from './harness.mjs';
import { detectHookManager, hookStatus } from './hooks.mjs';
import { detectPackageManager, fsReader, repoInstallCommand } from './pm.mjs';
import { register, registryPath } from './registry.mjs';

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const version = (cmd, args = ['--version']) => {
  const r = run(cmd, args);
  return r.status === 0 ? (/(\d+\.\d+\.\d+)/.exec(`${r.stdout}${r.stderr}`)?.[1] ?? null) : null;
};

/** The hook step for a manager: what setup does to git config, as { action, args?, message }. Pure. */
export function hookPlan(manager, hooksPath, existingHooks = []) {
  if (manager === 'githooks') {
    if (hooksPath === '.githooks') return { action: 'none', message: 'core.hooksPath is already .githooks' };
    if (hooksPath) return { action: 'none', message: `core.hooksPath is ${hooksPath}, not .githooks; left alone. If nothing else uses it: git config core.hooksPath .githooks` };
    if (existingHooks.length) {
      return {
        action: 'none',
        message: `.git/hooks has ${existingHooks.join(', ')} (git-lfs or another tool); core.hooksPath=.githooks would turn them off, so it is left unset. Move what they do into .githooks (its pre-push already runs git-lfs when .gitattributes uses LFS) and run: git config core.hooksPath .githooks`,
      };
    }
    return { action: 'set', args: ['config', 'core.hooksPath', '.githooks'], message: 'git config core.hooksPath .githooks' };
  }
  if (hooksPath === '.githooks') return { action: 'unset', args: ['config', '--unset', 'core.hooksPath'], message: `unset core.hooksPath (.githooks): it turns ${manager}'s hooks off` };
  return { action: 'none', message: `${manager} runs the hooks; core.hooksPath left ${hooksPath ?? 'unset'}` };
}

/** Hooks installed in the repo's own .git/hooks (not samples): setting core.hooksPath would bypass them. */
export function activeGitHooks(root) {
  let dir = tryGit(root, ['rev-parse', '--git-common-dir']);
  if (!dir) return [];
  if (!isAbsolute(dir)) dir = join(root, dir);
  try {
    return readdirSync(join(dir, 'hooks')).filter(name => !name.endsWith('.sample') && !name.startsWith('.')).sort();
  } catch {
    return [];
  }
}

/** The T3 settings text for a repo: worktree mode and a setup script that installs dependencies. */
export function t3Settings({ branch, install }) {
  return [
    'T3 settings for this project (apply them in T3; shiplane does not change T3):',
    `  Worktree mode: a new worktree per thread, from origin/${branch}`,
    '  Setup script (runs when a worktree is created):',
    ...(install ? [`    ${install}`] : ['    (none: no package manager found)']),
  ].join('\n');
}

/**
 * Step 5 of setup: the turn-end guard as a Stop hook in each harness found on this machine (user-level settings, so
 * every worktree gets it; the guard does nothing outside a shiplane repo). A harness whose hook the repo already commits
 * (project-level, written by shiplane init) gets no user-level one. Returns [{ ok, text }].
 */
export function installGuardHooks({ env = process.env, root = null, command = name => guardCommand(name) } = {}) {
  const found = detectHarnesses(env);
  if (!found.length) return [{ ok: null, text: 'guard: no Claude Code or Codex config directory here; nothing installed' }];
  return found.map(h => {
    if (projectGuard(root, h.name)) {
      const user = installedGuard(h.path);
      const trust = h.name === 'codex' ? ' (Codex loads it once you trust the project\'s .codex/ and the hook: /hooks)' : '';
      return { ok: true, text: `guard: ${h.label}: the repo's ${PROJECT_HOOKS[h.name].path} runs it (project-level); no user-level hook installed${user ? `. ${h.path} has one too: the guard runs once per stop (it dedupes)` : ''}${trust}` };
    }
    try {
      const r = installGuard(h, { command: command(h.name) });
      const trust = h.name === 'codex' ? ' (Codex asks you to trust a new hook once: /hooks)' : '';
      return { ok: true, text: `guard: ${h.label} Stop hook ${r.changed ? `installed in ${r.path}${r.backup ? ` (backup: ${r.backup})` : ''}` : `already in ${r.path}`}${trust}` };
    } catch (err) {
      return { ok: false, text: `guard: ${h.label}: ${err.message}` };
    }
  });
}

export function setup({ cwd = process.cwd(), log = console.log, env = process.env } = {}) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const root = mainWorktree(top);
  const config = loadConfig(top);
  const branch = shipBranch(config);
  let problems = 0;
  const say = (ok, text) => {
    if (ok === false) problems++;
    log(`${ok === true ? 'ok  ' : ok === false ? 'FAIL' : '--  '}  ${text}`);
  };

  // 1. The gate's hook, through the repo's manager.
  const reader = fsReader(top);
  const detected = detectHookManager(reader);
  const plan = hookPlan(detected.manager, tryGit(top, ['config', '--get', 'core.hooksPath']), activeGitHooks(top));
  if (plan.args) git(top, plan.args);
  say(null, `hooks: ${plan.message}`);
  const status = hookStatus(top, detected);
  say(status.ok, `pre-push: ${detected.manager}: ${status.detail}`);

  // 2. gh: auth, and the needs-me alias.
  const auth = run('gh', ['auth', 'status']);
  say(auth.status === 0, auth.status === 0 ? 'gh is logged in' : 'gh is not logged in: gh auth login');
  let slug = null;
  try {
    slug = repoInfo(top).slug;
  } catch (err) {
    say(false, `gh repo view failed: ${String(err.message).split('\n')[0]}`);
  }
  if (slug) {
    const owner = slug.split('/')[0];
    const alias = run('gh', ['alias', 'set', '--clobber', 'needs-me', `search prs --owner ${owner} --state open label:needs-owner,hold`]);
    say(alias.status === 0, alias.status === 0 ? `gh needs-me: open ${owner} PRs labelled needs-owner or hold` : `gh alias set failed: ${alias.stderr.trim()}`);
    // 3. Upkeep registry.
    const changed = register({ root, base: branch, slug });
    say(true, `${changed ? 'registered' : 'already registered'} ${root} for shiplane upkeep (${registryPath()})`);
  }

  // 4. Tools.
  const node = process.versions.node;
  say(Number(node.split('.')[0]) >= 20, `node ${node}${Number(node.split('.')[0]) >= 20 ? '' : ' (shiplane needs 20 or newer)'}`);
  const pm = detectPackageManager(reader);
  if (pm.name) {
    const local = version(pm.name);
    if (!local) say(false, `${pm.name} is not installed (the repo uses it)`);
    else if (pm.pin && pm.pin !== local) say(null, `${pm.name} ${local} here, repo pins ${pm.pin} (${pm.pinFile}): install with the pinned one (the setup script below does)`);
    else say(true, `${pm.name} ${local}${pm.pin ? ' (matches the pin)' : ''}`);
  }
  if (detected.manager !== 'githooks' && !existsSync(join(top, 'node_modules')) && pm.name) say(null, `no node_modules here: ${detected.manager}'s hooks are installed by \`${repoInstallCommand(config, reader)}\``);

  // 5. The turn-end guard.
  for (const r of installGuardHooks({ env, root: top })) say(r.ok, r.text);

  log('');
  log(t3Settings({ branch, install: repoInstallCommand(config, reader) }));
  return problems ? 1 : 0;
}
