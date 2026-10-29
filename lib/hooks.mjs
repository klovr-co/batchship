// Which mechanism runs git hooks in a repo, whether it runs tug's pre-push gate, and how to wire it in.
// Setting core.hooksPath=.githooks in a repo that uses lefthook or husky silently turns their hooks off, so tug
// uses .githooks only when no hook manager is there, and otherwise plugs its gate into the manager.
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tryGit } from './git.mjs';

export const GATE = '.agents/tug/pre-push.mjs';
export const GATE_COMMAND = `node ${GATE} --hook`;
const LEFTHOOK_FILES = ['lefthook.yml', '.lefthook.yml', 'lefthook.yaml', '.lefthook.yaml', 'lefthook.json', '.lefthook.json', 'lefthook.toml', '.lefthook.toml'];
const SIMPLE_GIT_HOOKS_FILES = ['.simple-git-hooks.json', '.simple-git-hooks.js', '.simple-git-hooks.cjs', 'simple-git-hooks.json', 'simple-git-hooks.js', 'simple-git-hooks.cjs'];

/**
 * The repo's hook manager, from its files (reader: { read, exists, isDir? }):
 * { manager: 'lefthook'|'husky'|'simple-git-hooks'|'pre-commit'|'npm-pre-push'|'githooks', file, wired, hasPrePush }.
 * wired: its config already runs tug's gate. hasPrePush: it already defines a pre-push hook of its own.
 */
export function detectHookManager(reader) {
  const mentions = text => typeof text === 'string' && text.includes(GATE);
  for (const file of LEFTHOOK_FILES) {
    if (!reader.exists(file)) continue;
    const text = reader.read(file) || '';
    return { manager: 'lefthook', file, wired: mentions(text), hasPrePush: /^pre-push\s*:/m.test(text) || /"pre-push"\s*:/.test(text) || /^\[pre-push/m.test(text) };
  }
  if (reader.isDir ? reader.isDir('.husky') : reader.exists('.husky')) {
    const text = reader.read('.husky/pre-push');
    return { manager: 'husky', file: '.husky/pre-push', wired: mentions(text), hasPrePush: text != null };
  }
  let pkg = null;
  try {
    pkg = JSON.parse(reader.read('package.json') || 'null');
  } catch { /* not JSON */ }
  const sgh = SIMPLE_GIT_HOOKS_FILES.find(f => reader.exists(f));
  if (pkg?.['simple-git-hooks'] || sgh) {
    const cfg = pkg?.['simple-git-hooks'];
    const text = cfg ? JSON.stringify(cfg) : reader.read(sgh);
    return { manager: 'simple-git-hooks', file: cfg ? 'package.json' : sgh, wired: mentions(text), hasPrePush: /pre-push/.test(text || '') };
  }
  if (reader.exists('.pre-commit-config.yaml')) {
    const text = reader.read('.pre-commit-config.yaml');
    return { manager: 'pre-commit', file: '.pre-commit-config.yaml', wired: mentions(text), hasPrePush: /pre-push/.test(text || '') };
  }
  if (pkg && (pkg['pre-push'] || pkg['pre-commit'])) {
    const text = JSON.stringify(pkg['pre-push'] ?? '');
    return { manager: 'npm-pre-push', file: 'package.json', wired: mentions(text), hasPrePush: !!pkg['pre-push'] };
  }
  const text = reader.read('.githooks/pre-push');
  return { manager: 'githooks', file: '.githooks/pre-push', wired: mentions(text), hasPrePush: text != null };
}

/** The lines a manager's config needs to run tug's gate (for a person or the adopt skill to paste). */
export function manualSnippet(manager) {
  switch (manager) {
    case 'lefthook':
      return `pre-push:\n  commands:\n    tug:\n      run: ${GATE_COMMAND}\n      use_stdin: true`;
    case 'husky':
      return `${GATE_COMMAND} "$@"   # in .husky/pre-push`;
    case 'simple-git-hooks':
      return `"simple-git-hooks": { "pre-push": "${GATE_COMMAND}" }`;
    case 'pre-commit':
      return `- repo: local\n  hooks:\n    - id: tug\n      name: tug pre-push gate\n      entry: node ${GATE}\n      language: system\n      stages: [pre-push]\n      pass_filenames: false\n      always_run: true`;
    default:
      return GATE_COMMAND;
  }
}

/**
 * The file change that wires tug's gate into the repo, or a manual step when tug cannot do it safely:
 * { path, content, mode } | { manual: text } | { already: true }.
 * tug edits a manager's config only by appending a pre-push section that does not exist yet; it never rewrites one.
 */
export function wireHook(detected, reader, { template, force = false } = {}) {
  if (detected.wired) return { already: true };
  switch (detected.manager) {
    case 'githooks':
      if (detected.hasPrePush && !force) {
        return { manual: `.githooks/pre-push exists and does not run tug's gate. Make it run \`${GATE_COMMAND} "$@"\` (or move its check into checkCommand and rerun \`tug init --force\`).` };
      }
      return { path: '.githooks/pre-push', content: template, mode: 0o755 };
    case 'lefthook': {
      const text = reader.read(detected.file) || '';
      if (detected.hasPrePush || !/\.ya?ml$/.test(detected.file)) {
        return { manual: `${detected.file} has its own pre-push section (or is not YAML). Add tug's gate to it:\n${manualSnippet('lefthook')}` };
      }
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const body = `${text.replace(/(\r?\n)*$/, '')}${eol}${eol}# tug pre-push gate (.agents/tug/pre-push.mjs): line endings, generated files, checkCommand.${eol}${manualSnippet('lefthook').replace(/\n/g, eol)}${eol}`;
      return { path: detected.file, content: body };
    }
    case 'husky':
      if (detected.hasPrePush) return { manual: `.husky/pre-push exists. Add this line to it:\n${manualSnippet('husky')}` };
      return { path: '.husky/pre-push', content: `# tug pre-push gate. Never skip it with --no-verify.\n${GATE_COMMAND} "$@"\n`, mode: 0o755 };
    default:
      return { manual: `${detected.file} (${detected.manager}) manages hooks. Add tug's gate to its pre-push hook:\n${manualSnippet(detected.manager)}` };
  }
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * On this machine: does `git push` run tug's gate? { ok, mechanism, hooksPath, hookFile, detail }.
 * hookFile is the file git will run (git rev-parse --git-path accounts for core.hooksPath).
 */
export function hookStatus(root, detected) {
  const hooksPath = tryGit(root, ['config', '--get', 'core.hooksPath']) || null;
  let hookFile = tryGit(root, ['rev-parse', '--git-path', 'hooks/pre-push']);
  if (hookFile && !isAbsolute(hookFile)) hookFile = join(root, hookFile);
  const runs = hookFile && existsSync(hookFile) && executable(hookFile);
  const text = runs ? readFileSync(hookFile, 'utf8') : '';
  const base = { mechanism: detected.manager, hooksPath, hookFile };
  if (!detected.wired) return { ...base, ok: false, detail: `${detected.file} does not run tug's gate (tug init wires it, or: ${manualSnippet(detected.manager).split('\n')[0]})` };
  if (!runs) return { ...base, ok: false, detail: `git runs no pre-push hook here (${hookFile} missing or not executable)${detected.manager === 'githooks' ? ': run tug setup' : `: install ${detected.manager}'s hooks (your install command usually does)`}` };
  switch (detected.manager) {
    case 'githooks':
      return text.includes(GATE) ? { ...base, ok: true, detail: 'core.hooksPath=.githooks; pre-push runs the gate' } : { ...base, ok: false, detail: `core.hooksPath is ${hooksPath ?? 'unset'}, so git runs ${hookFile}, not .githooks/pre-push: run tug setup` };
    case 'lefthook':
      if (hooksPath === '.githooks') return { ...base, ok: false, detail: 'core.hooksPath=.githooks turns lefthook off: run tug setup (it unsets it)' };
      return /lefthook/i.test(text) ? { ...base, ok: true, detail: `lefthook's pre-push hook runs; ${detected.file} runs the gate` } : { ...base, ok: false, detail: `${hookFile} is not lefthook's: run lefthook install` };
    case 'husky':
      return /husky/i.test(text) || text.includes(GATE) ? { ...base, ok: true, detail: 'husky runs .husky/pre-push, which runs the gate' } : { ...base, ok: false, detail: `${hookFile} is not husky's: run your install command (husky's prepare script)` };
    default:
      return { ...base, ok: true, detail: `${detected.manager} pre-push hook present (${hookFile}); not checked that it calls the gate` };
  }
}
