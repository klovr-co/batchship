// Part of tug. `tug init` copies this file into .agents/tug/; edit it in the tug repo, not there.
// Package manager detection: which one a repo uses, the version it pins, and how a fresh worktree installs.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Reads files relative to a directory on disk: { read(path) -> string|null, exists(path) -> bool }. */
export function fsReader(root) {
  return {
    read(path) {
      try {
        return readFileSync(join(root, path), 'utf8');
      } catch {
        return null;
      }
    },
    exists: path => existsSync(join(root, path)),
    isDir(path) {
      try {
        return statSync(join(root, path)).isDirectory();
      } catch {
        return false;
      }
    },
  };
}

function packageJson(reader) {
  const text = reader.read('package.json');
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * { name: 'bun'|'pnpm'|'yarn'|'npm'|null, pin: version string or null, pinFile: where the pin came from }.
 * The packageManager field wins; then lockfiles. Bun's pin also comes from .bun-version.
 */
export function detectPackageManager(reader) {
  const pkg = packageJson(reader);
  let name = null;
  let pin = null;
  let pinFile = null;
  const field = typeof pkg?.packageManager === 'string' ? /^(bun|pnpm|yarn|npm)@([^+\s]+)/.exec(pkg.packageManager) : null;
  if (field) {
    [, name, pin] = field;
    pinFile = 'package.json packageManager';
  } else if (reader.exists('bun.lock') || reader.exists('bun.lockb')) name = 'bun';
  else if (reader.exists('pnpm-lock.yaml')) name = 'pnpm';
  else if (reader.exists('yarn.lock')) name = 'yarn';
  else if (reader.exists('package-lock.json') || pkg) name = 'npm';
  let bunVersionFile = false;
  if (name === 'bun') {
    const file = reader.read('.bun-version');
    if (file && file.trim()) {
      bunVersionFile = true;
      if (!pin) {
        pin = file.trim();
        pinFile = '.bun-version';
      }
    }
  }
  return { name, pin, pinFile, bunVersionFile, hasPackageJson: !!pkg };
}

/** The command that installs a fresh worktree's dependencies, or null when there is nothing to install. */
export function installCommand(pm) {
  switch (pm.name) {
    case 'bun':
      // The local bun can differ from the repo's pin (1.4.4 vs 1.3.10 broke a lockfile once): run the pinned one.
      if (pm.bunVersionFile) return 'bunx bun@$(cat .bun-version) install --frozen-lockfile';
      return pm.pin ? `bunx bun@${pm.pin} install --frozen-lockfile` : 'bun install --frozen-lockfile';
    case 'pnpm':
      return 'pnpm install --frozen-lockfile --prefer-offline';
    case 'yarn':
      return pm.pin && /^1\./.test(pm.pin) ? 'yarn install --frozen-lockfile' : 'yarn install --immutable';
    case 'npm':
      return 'npm ci';
    default:
      return null;
  }
}

/** The install command for a repo: config.installCommand when set, else detected. */
export function repoInstallCommand(config, reader) {
  return config?.installCommand || installCommand(detectPackageManager(reader));
}

/** True when the repo has a package.json but this checkout has no node_modules (a fresh worktree). */
export function depsMissing(root) {
  return existsSync(join(root, 'package.json')) && !existsSync(join(root, 'node_modules'));
}
