// Test helpers. Safety rule: a test that uses git makes its own repo under the OS temp dir first, and every git call
// passes that path explicitly as cwd (no process.chdir). A path that is empty or outside the temp dir aborts.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';

const TMP = realpathSync(tmpdir());
// The code under test runs git too: keep this machine's global and system git config out of it.
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = join(TMP, 'tug-test-no-global-gitconfig');

/** Throws unless `path` is a non-empty path strictly inside the OS temp dir. */
export function assertInTmp(path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error(`refusing: empty path ${JSON.stringify(path)}`);
  const real = realpathSync(path);
  if (!real.startsWith(TMP + sep) || real === TMP) throw new Error(`refusing: ${real} is not inside ${TMP}`);
  return real;
}

/** Git with no global or system config (no hooks, signing or templates from this machine) and no network remotes. */
export function testGit(cwd, args, options = {}) {
  assertInTmp(cwd);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(TMP, 'tug-test-no-global-gitconfig'), GIT_TERMINAL_PROMPT: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  return execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

/** A fresh repo on branch main with one commit; origin/main points at it (a ref only: there is no remote). */
export function tempRepo(files = { 'README.md': 'hello\n' }) {
  const dir = assertInTmp(mkdtempSync(join(TMP, 'tug-test-')));
  testGit(dir, ['init', '-q', '-b', 'main']);
  testGit(dir, ['config', 'user.email', 'test@example.com']);
  testGit(dir, ['config', 'user.name', 'tug test']);
  testGit(dir, ['config', 'commit.gpgsign', 'false']);
  testGit(dir, ['config', 'core.autocrlf', 'false']);
  writeFiles(dir, files);
  testGit(dir, ['add', '-A']);
  testGit(dir, ['commit', '-q', '-m', 'base']);
  testGit(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return dir;
}

export function writeFiles(dir, files) {
  assertInTmp(dir);
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export function commit(dir, files, message = 'change') {
  writeFiles(dir, files);
  testGit(dir, ['add', '-A']);
  testGit(dir, ['commit', '-q', '-m', message]);
  return testGit(dir, ['rev-parse', 'HEAD']).trim();
}

export function removeRepo(dir) {
  rmSync(assertInTmp(dir), { recursive: true, force: true });
}

/** A reader over an in-memory file map (the interface planInit and detectHookManager take). */
export function memReader(files) {
  const dirs = new Set();
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    read: p => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null),
    exists: p => Object.prototype.hasOwnProperty.call(files, p) || dirs.has(p),
    isDir: p => dirs.has(p),
    list: dir => Object.keys(files).filter(p => dirname(p) === dir),
  };
}
