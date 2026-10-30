// Which mechanism runs git hooks in a repo, whether it runs shiplane's pre-push gate, and how to wire it in.
// Setting core.hooksPath=.githooks in a repo that uses lefthook or husky silently turns their hooks off, so shiplane
// uses .githooks only when no hook manager is there, and otherwise plugs its gate into the manager.
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tryGit } from './git.mjs';

export const GATE = '.agents/shiplane/pre-push.mjs';
export const GATE_COMMAND = `node ${GATE} --hook`;
/** The gate checking HEAD (no stdin): for a lefthook section where another job already takes git's stdin. */
export const GATE_HEAD_COMMAND = `node ${GATE}`;
/** Where shiplane keeps a repo's own .githooks/pre-push, which shiplane's hook runs first. */
export const REPO_HOOK = '.githooks/pre-push.repo';
/** A file shiplane wrote (or tug, its name until 1.1.1): init may rewrite it. */
export const MANAGED = /^# Managed by (?:shiplane|tug)\b/m;

/** shiplane's .githooks/pre-push, running the repo's own hook (REPO_HOOK) first when it has one. */
export function githooksPrePush(template, { repoHook = false } = {}) {
  const call = repoHook ? `# The repo's own pre-push check (its hook before shiplane, kept in ${REPO_HOOK}) runs first.\nprintf '%s\\n' "$input" | ./${REPO_HOOK} "$@" || exit 1\n` : '';
  return template.replace('{{repoHook}}', call);
}

/**
 * lefthook config text with shiplane's gate merged into its existing top-level pre-push section (a `commands:` entry, a
 * `jobs:` item, or a new `commands:`), or null when the section's shape is not one shiplane can edit safely. Only the
 * section's lines change. lefthook passes git's stdin to one use_stdin job only, so when another job already takes
 * it, the gate runs without --hook (it checks HEAD).
 */
export function mergeLefthookPrePush(text, parse) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(l => /^pre-push\s*:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !(lines[end].trim() && !/^\s/.test(lines[end]) && !/^#/.test(lines[end]))) end++;
  while (end > start + 1 && (!lines[end - 1].trim() || /^#/.test(lines[end - 1]))) end--; // leave the next section's comments
  const body = lines.slice(start + 1, end);
  const content = body.filter(l => l.trim() && !/^\s*#/.test(l));
  if (!content.length) return null;
  const indentOf = l => /^ */.exec(l)[0].length;
  const ci = indentOf(content[0]);
  if (!ci || content.some(l => /\t/.test(/^\s*/.exec(l)[0]))) return null;
  const pad = n => ' '.repeat(n);
  const takenStdin = /^\s*use_stdin:\s*true\b/m.test(body.join('\n'));
  const run = takenStdin ? GATE_HEAD_COMMAND : GATE_COMMAND;
  const stdinLine = takenStdin ? [] : ['use_stdin: true'];
  const note = `# shiplane pre-push gate (.agents/shiplane/pre-push.mjs): line endings, generated files, checkCommand.${takenStdin ? ' Another job takes git\'s stdin (lefthook gives it to one only), so it checks HEAD.' : ''}`;
  const find = key => body.findIndex(l => indentOf(l) === ci && new RegExp(`^\\s*${key}:\\s*(#.*)?$`).test(l));
  const blockEnd = at => {
    let k = at + 1;
    while (k < body.length && (!body[k].trim() || indentOf(body[k]) > ci)) k++;
    while (k > at + 1 && !body[k - 1].trim()) k--;
    return k;
  };
  let insert;
  let added;
  const commands = find('commands');
  const jobs = find('jobs');
  if (commands >= 0) {
    const child = body.slice(commands + 1).find(l => l.trim() && !/^\s*#/.test(l));
    const c2 = child && indentOf(child) > ci ? indentOf(child) : ci * 2;
    insert = blockEnd(commands);
    added = [`${pad(c2)}${note}`, `${pad(c2)}shiplane:`, `${pad(c2 + ci)}run: ${run}`, ...stdinLine.map(l => `${pad(c2 + ci)}${l}`)];
  } else if (jobs >= 0) {
    const child = body.slice(jobs + 1).find(l => l.trim() && !/^\s*#/.test(l));
    if (!child || !/^\s*- /.test(child)) return null;
    const ji = indentOf(child);
    insert = blockEnd(jobs);
    added = [`${pad(ji)}${note}`, `${pad(ji)}- name: shiplane pre-push gate`, `${pad(ji + 2)}run: ${run}`, ...stdinLine.map(l => `${pad(ji + 2)}${l}`)];
  } else {
    if (find('scripts') >= 0 || content.some(l => indentOf(l) === ci && /^\s*- /.test(l))) return null;
    insert = body.length;
    while (insert > 0 && !body[insert - 1].trim()) insert--;
    added = [`${pad(ci)}${note}`, `${pad(ci)}commands:`, `${pad(ci * 2)}shiplane:`, `${pad(ci * 3)}run: ${run}`, ...stdinLine.map(l => `${pad(ci * 3)}${l}`)];
  }
  const newBody = [...body.slice(0, insert), ...added, ...body.slice(insert)];
  const out = [...lines.slice(0, start + 1), ...newBody, ...lines.slice(end)];
  // Check: the section still reads, with everything it had plus shiplane's entry.
  if (parse) {
    try {
      const before = parse([lines[start], ...body].join('\n'))['pre-push'];
      const after = parse([lines[start], ...newBody].join('\n'))['pre-push'];
      if (!JSON.stringify(after).includes(run)) return null;
      for (const [k, v] of Object.entries(before || {})) {
        if (k === 'commands' && after.commands) { for (const [ck, cv] of Object.entries(v || {})) if (JSON.stringify(after.commands[ck]) !== JSON.stringify(cv)) return null; }
        else if (k === 'jobs' && Array.isArray(after.jobs)) { if (JSON.stringify(after.jobs.slice(0, v.length)) !== JSON.stringify(v)) return null; }
        else if (JSON.stringify(after[k]) !== JSON.stringify(v)) return null;
      }
    } catch {
      return null;
    }
  }
  return out.join(eol);
}
const LEFTHOOK_FILES = ['lefthook.yml', '.lefthook.yml', 'lefthook.yaml', '.lefthook.yaml', 'lefthook.json', '.lefthook.json', 'lefthook.toml', '.lefthook.toml'];
const SIMPLE_GIT_HOOKS_FILES = ['.simple-git-hooks.json', '.simple-git-hooks.js', '.simple-git-hooks.cjs', 'simple-git-hooks.json', 'simple-git-hooks.js', 'simple-git-hooks.cjs'];

/**
 * The repo's hook manager, from its files (reader: { read, exists, isDir? }):
 * { manager: 'lefthook'|'husky'|'husky4'|'simple-git-hooks'|'pre-commit'|'npm-pre-push'|'githooks', file, wired, hasPrePush }.
 * wired: its config already runs shiplane's gate. hasPrePush: it already defines a pre-push hook of its own.
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
  if (pkg?.husky && typeof pkg.husky === 'object') {
    // husky v4: hooks in package.json, installed into .git/hooks.
    const text = JSON.stringify(pkg.husky);
    return { manager: 'husky4', file: 'package.json', wired: mentions(text), hasPrePush: /pre-push/.test(text) };
  }
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

/** The lines a manager's config needs to run shiplane's gate (for a person or the adopt skill to paste). */
export function manualSnippet(manager) {
  switch (manager) {
    case 'lefthook':
      return `pre-push:\n  commands:\n    shiplane:\n      run: ${GATE_COMMAND}\n      use_stdin: true`;
    case 'husky':
      return `${GATE_COMMAND} "$@"   # in .husky/pre-push`;
    case 'husky4':
      return `"husky": { "hooks": { "pre-push": "${GATE_COMMAND}" } }   # in package.json`;
    case 'simple-git-hooks':
      return `"simple-git-hooks": { "pre-push": "${GATE_COMMAND}" }`;
    case 'pre-commit':
      return `- repo: local\n  hooks:\n    - id: shiplane\n      name: shiplane pre-push gate\n      entry: node ${GATE}\n      language: system\n      stages: [pre-push]\n      pass_filenames: false\n      always_run: true`;
    default:
      return GATE_COMMAND;
  }
}

/**
 * The file change that wires shiplane's gate into the repo, or a manual step when shiplane cannot do it safely:
 * { path, content, mode } | { manual: text } | { already: true }.
 * shiplane edits a manager's config only by appending a pre-push section that does not exist yet; it never rewrites one.
 */
export function wireHook(detected, reader, { template, force = false, parse = null, checkCommand = null } = {}) {
  if (detected.manager === 'githooks') {
    const text = reader.read('.githooks/pre-push');
    const keptRepoHook = reader.exists(REPO_HOOK);
    if (text == null || (text != null && MANAGED.test(text)) || force) {
      return { path: '.githooks/pre-push', content: githooksPrePush(template, { repoHook: keptRepoHook }), mode: 0o755 };
    }
    if (detected.wired) return { already: true };
    // The repo's own hook: keep it as REPO_HOOK and run it first, unless the gate already runs the same check.
    if (keptRepoHook) return { manual: `.githooks/pre-push and ${REPO_HOOK} both exist and neither is shiplane's. Make .githooks/pre-push run \`${GATE_COMMAND} "$@"\` (or shiplane init --force).` };
    // A duplicate only when every command line in it runs checkCommand's script (guards like `[ -f x ] || exit 0` aside).
    const script = checkCommand ? String(checkCommand).split(/\s+/).find(w => /\.(m?js|cjs|sh|ts|py)$/.test(w)) : null;
    const commands = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !/^\[ .*\]\s*\|\|\s*exit 0$/.test(l) && !/^command -v /.test(l));
    const duplicate = Boolean(script) && commands.length > 0 && commands.every(l => l.includes(script));
    if (duplicate) return { path: '.githooks/pre-push', content: githooksPrePush(template), mode: 0o755, note: `replaced the repo's .githooks/pre-push: it ran checkCommand (${checkCommand}), which the gate runs` };
    return {
      path: '.githooks/pre-push',
      content: githooksPrePush(template, { repoHook: true }),
      mode: 0o755,
      extra: [{ path: REPO_HOOK, content: text, mode: 0o755, why: "the repo's own pre-push hook, moved here; shiplane's .githooks/pre-push runs it first, then the gate" }],
    };
  }
  if (detected.wired) return { already: true };
  switch (detected.manager) {
    case 'lefthook': {
      const text = reader.read(detected.file) || '';
      if (!/\.ya?ml$/.test(detected.file)) return { manual: `${detected.file} is not YAML. Add shiplane's gate to its pre-push hook:\n${manualSnippet('lefthook')}` };
      if (detected.hasPrePush) {
        const merged = mergeLefthookPrePush(text, parse);
        if (merged) return { path: detected.file, content: merged, merged: true };
        return { manual: `${detected.file} has a pre-push section shiplane cannot edit safely. Add shiplane's gate to it:\n${manualSnippet('lefthook')}` };
      }
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const body = `${text.replace(/(\r?\n)*$/, '')}${eol}${eol}# shiplane pre-push gate (.agents/shiplane/pre-push.mjs): line endings, generated files, checkCommand.${eol}${manualSnippet('lefthook').replace(/\n/g, eol)}${eol}`;
      return { path: detected.file, content: body };
    }
    case 'husky': {
      if (!detected.hasPrePush) return { path: '.husky/pre-push', content: `# shiplane pre-push gate. Never skip it with --no-verify.\n${GATE_COMMAND} "$@"\n`, mode: 0o755 };
      const text = reader.read('.husky/pre-push') || '';
      // Appended last; a hook that exits or execs before the end would never reach it.
      if (/^\s*(exit|exec)\b/m.test(text)) return { manual: `.husky/pre-push ends early (exit/exec). Add this line to it:\n${manualSnippet('husky')}` };
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      return { path: '.husky/pre-push', content: `${text.replace(/(\r?\n)*$/, '')}${eol}# shiplane pre-push gate (reads what is left of git's stdin; with none it checks HEAD).${eol}${GATE_COMMAND} "$@"${eol}`, mode: 0o755 };
    }
    default:
      return { manual: `${detected.file} (${detected.manager}) manages hooks. Add shiplane's gate to its pre-push hook:\n${manualSnippet(detected.manager)}` };
  }
}

/**
 * Whether the repo's install step turns its hook manager on by itself: lefthook through a prepare/postinstall
 * script (or the lefthook npm package), husky through prepare. Returns { auto, why }.
 */
export function hookInstallStep(detected, reader) {
  let pkg = null;
  try {
    pkg = JSON.parse(reader.read('package.json') || 'null');
  } catch { /* not JSON */ }
  const scripts = pkg?.scripts || {};
  const run = `${scripts.prepare || ''}\n${scripts.postinstall || ''}`;
  const ignoreScripts = /^\s*ignoreScripts\s*=\s*true/m.test(reader.read('bunfig.toml') || '') || /^\s*ignore-scripts\s*=\s*true/m.test(reader.read('.npmrc') || '');
  const auto = detected.manager === 'lefthook' ? /lefthook\s+install/.test(run) : detected.manager === 'husky' ? /husky/.test(run) : false;
  if (!['lefthook', 'husky'].includes(detected.manager)) return { auto: false, why: null };
  if (auto && ignoreScripts) return { auto: false, why: `the install step skips scripts (ignoreScripts), so ${detected.manager}'s prepare script does not run: each checkout runs \`${detected.manager} install\` once` };
  return auto ? { auto: true, why: `${detected.manager}'s hooks are installed by the package manager's prepare script` } : { auto: false, why: `nothing installs ${detected.manager}'s hooks automatically: each checkout runs \`${detected.manager} install\` once` };
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
 * On this machine: does `git push` run shiplane's gate? { ok, mechanism, hooksPath, hookFile, detail }.
 * hookFile is the file git will run (git rev-parse --git-path accounts for core.hooksPath).
 */
export function hookStatus(root, detected) {
  const hooksPath = tryGit(root, ['config', '--get', 'core.hooksPath']) || null;
  let hookFile = tryGit(root, ['rev-parse', '--git-path', 'hooks/pre-push']);
  if (hookFile && !isAbsolute(hookFile)) hookFile = join(root, hookFile);
  const runs = hookFile && existsSync(hookFile) && executable(hookFile);
  const text = runs ? readFileSync(hookFile, 'utf8') : '';
  const base = { mechanism: detected.manager, hooksPath, hookFile };
  if (!detected.wired) return { ...base, ok: false, detail: `${detected.file} does not run shiplane's gate (shiplane init wires it, or: ${manualSnippet(detected.manager).split('\n')[0]})` };
  if (!runs) return { ...base, ok: false, detail: `git runs no pre-push hook here (${hookFile} missing or not executable)${detected.manager === 'githooks' ? ': run git config core.hooksPath .githooks (or shiplane setup)' : `: install ${detected.manager}'s hooks (your install command usually does)`}` };
  switch (detected.manager) {
    case 'githooks':
      return text.includes(GATE) ? { ...base, ok: true, detail: 'core.hooksPath=.githooks; pre-push runs the gate' } : { ...base, ok: false, detail: `core.hooksPath is ${hooksPath ?? 'unset'}, so git runs ${hookFile}, not .githooks/pre-push: the gate is off here; run git config core.hooksPath .githooks (or shiplane setup)` };
    case 'lefthook':
      if (hooksPath === '.githooks') return { ...base, ok: false, detail: 'core.hooksPath=.githooks turns lefthook off: run shiplane setup (it unsets it)' };
      return /lefthook/i.test(text) ? { ...base, ok: true, detail: `lefthook's pre-push hook runs; ${detected.file} runs the gate` } : { ...base, ok: false, detail: `${hookFile} is not lefthook's: run lefthook install` };
    case 'husky':
      return /husky/i.test(text) || text.includes(GATE) ? { ...base, ok: true, detail: 'husky runs .husky/pre-push, which runs the gate' } : { ...base, ok: false, detail: `${hookFile} is not husky's: run your install command (husky's prepare script)` };
    default:
      return { ...base, ok: true, detail: `${detected.manager} pre-push hook present (${hookFile}); not checked that it calls the gate` };
  }
}
