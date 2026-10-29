// Part of tug. `tug init` copies this file into .agents/tug/; edit it in the tug repo, not there.
import { execFileSync, spawnSync } from 'node:child_process';

/** Git variables a hook inherits that would point a child process at the wrong checkout. */
const GIT_LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of GIT_LOCATION_VARS) delete env[name];
  return env;
}

/** Run git in `cwd`; returns stdout (utf8 unless encoding is set). Throws on a non-zero exit. */
export function git(cwd, args, options = {}) {
  if (!cwd) throw new Error('git: no working directory given');
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

/** Like git(), but returns null instead of throwing. Output is trimmed. */
export function tryGit(cwd, args, options = {}) {
  try {
    return git(cwd, args, options).trim();
  } catch {
    return null;
  }
}

/** True when git exits 0. */
export function gitOk(cwd, args) {
  if (!cwd) return false;
  return spawnSync('git', args, { cwd, stdio: 'ignore', env: cleanEnv() }).status === 0;
}

export const ZERO_SHA = /^0+$/;
