// From tug to shiplane: the kit was named tug until 1.1.1. A repo that ran `tug init` (1.1.0) has its runtime in
// .agents/tug/, a .agents/tug.lock, a <!-- tug:start --> block in AGENTS.md, .github/workflows/tug-events.yml, hook
// configs and project hooks that call .agents/tug/..., and .gitignore exceptions for them. `shiplane init` moves all of
// it in the same PRs (planTugMigration), `shiplane setup` moves the user-level hooks and the upkeep registry, and
// `shiplane doctor` reports what is left (tugLeftovers). Pure where it can be: the readers are the init readers.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LEGACY_EVENTS_PATH } from './render.mjs';

export { LEGACY_EVENTS_PATH };

export const LEGACY_NAME = 'tug';
export const LEGACY_RUNTIME_DIR = '.agents/tug';
export const LEGACY_LOCK_PATH = '.agents/tug.lock';
/** The files tug 1.1.0 vendored into .agents/tug/ (any other file there is the repo's own and is moved, not dropped). */
export const LEGACY_RUNTIME_FILES = ['tug.mjs', 'version.mjs', 'ship.mjs', 'gh.mjs', 'state.mjs', 'guard.mjs', 'git.mjs', 'yaml.mjs', 'config.mjs', 'pm.mjs', 'pre-push.mjs', 'checks/line-endings.mjs', 'checks/generated-current.mjs'];
/** Files that may run the gate from .agents/tug/: every hook manager's config, the hook directories, package.json. */
const HOOK_FILES = ['lefthook.yml', '.lefthook.yml', 'lefthook.yaml', '.lefthook.yaml', 'lefthook.json', '.lefthook.json', 'lefthook.toml', '.lefthook.toml', 'package.json', '.pre-commit-config.yaml', '.simple-git-hooks.json', '.simple-git-hooks.js', '.simple-git-hooks.cjs', 'simple-git-hooks.json', 'simple-git-hooks.js', 'simple-git-hooks.cjs'];
const HOOK_DIRS = ['.githooks', '.husky'];

/** `.agents/tug/...` or `.agents/tug.lock` in any text (not `.agents/tugboat`). */
const LEGACY_PATH = /\.agents\/tug(?=\/|\.lock\b|\s|$|["'`*])/g;
export const mentionsLegacyPath = text => typeof text === 'string' && new RegExp(LEGACY_PATH.source).test(text);

/** A hook command that runs tug's guard: `.../tug.mjs" guard`, `tug guard` (any path, any version). */
export const isLegacyGuardCommand = command => typeof command === 'string' && /(?<![\w-])tug(?:\.mjs)?['"]?\s+guard\b/.test(command);

/** Every blob under dir: the reader's walk() when it has one, else list() on dir and its known subdirectories. */
export function blobsUnder(reader, dir) {
  if (reader.walk) return reader.walk(dir);
  const out = [];
  const seen = new Set();
  const visit = d => {
    if (seen.has(d)) return;
    seen.add(d);
    for (const p of reader.list?.(d) || []) out.push(p);
    for (const sub of ['checks']) if (reader.isDir?.(`${d}/${sub}`)) visit(`${d}/${sub}`);
  };
  visit(dir);
  return [...new Set(out)].sort();
}

/**
 * A hook config or hook script with tug's gate moved to shiplane's: the .agents/tug/ path, tug's comments, the lefthook
 * command key `tug:` (only when its run line is the gate) and the pre-commit id. Everything else is byte-for-byte kept.
 */
export function migrateHookText(text) {
  if (text == null) return text;
  let out = String(text).replace(LEGACY_PATH, '.agents/shiplane');
  out = out.replace(/^(#\s*)Managed by tug\b/gm, '$1Managed by shiplane');
  out = out.replace(/\btug pre-push gate\b/g, 'shiplane pre-push gate');
  out = out.replace(/^(\s*-\s*id:\s*)tug(\s*(?:#.*)?)$/gm, '$1shiplane$2');
  const eolSplit = out.split('\n');
  for (let i = 0; i < eolSplit.length; i++) {
    const m = /^(\s+)tug:(\s*(?:#.*)?\r?)$/.exec(eolSplit[i]);
    if (!m) continue;
    const indent = m[1].length;
    for (let k = i + 1; k < eolSplit.length; k++) {
      const line = eolSplit[k];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      if (/^ */.exec(line)[0].length <= indent) break;
      if (/^\s*run:.*\.agents\/shiplane\/pre-push\.mjs/.test(line)) {
        eolSplit[i] = `${m[1]}shiplane:${m[2]}`;
        break;
      }
    }
  }
  return eolSplit.join('\n');
}

/** .gitignore with every rule naming .agents/tug/ or .agents/tug.lock pointed at shiplane's paths. */
export function migrateGitignore(text) {
  if (text == null) return text;
  return String(text).split('\n').map(line => (/^\s*#/.test(line) ? line : line.replace(/\.agents\/tug(?=\/|\.lock\b|\r?$|\*)/g, '.agents/shiplane'))).join('\n');
}

/**
 * What `shiplane init` changes in a tug repo, before its own steps run:
 * { changes: Map(path -> new text | null for a delete), why: Map(path -> text), notes: [text], legacyEvents: text|null, found: bool }.
 * The init steps then read the repo through overlayReader(reader, changes), so they see the migrated files.
 * Not here: the AGENTS.md block (renderer: upsertAgentsBlock replaces a tug block), the project hooks (mergeGuardHook
 * replaces tug's guard command), .mergify.yml (re-rendered: it is managed), the events workflow (init step 9).
 */
export function planTugMigration(reader, { runtimeFiles = [] } = {}) {
  const changes = new Map();
  const why = new Map();
  const notes = [];
  const set = (path, content, reason) => {
    changes.set(path, content);
    why.set(path, reason);
  };

  // 1. .agents/tug/ -> .agents/shiplane/: the kit's files are re-written by init's runtime step; the repo's own are moved.
  let lock = null;
  try {
    lock = JSON.parse(reader.read(LEGACY_LOCK_PATH) || 'null');
  } catch { /* unreadable: treated as none */ }
  const kitNames = new Set([...LEGACY_RUNTIME_FILES, ...runtimeFiles]);
  const moved = [];
  for (const path of blobsUnder(reader, LEGACY_RUNTIME_DIR)) {
    const rel = path.slice(LEGACY_RUNTIME_DIR.length + 1);
    if (kitNames.has(rel)) {
      set(path, null, rel === 'tug.mjs' ? 'tug\'s runtime entry; now .agents/shiplane/shiplane.mjs' : `tug's runtime; now .agents/shiplane/${rel}`);
      continue;
    }
    const target = `.agents/shiplane/${rel}`;
    if (reader.exists(target)) {
      notes.push(`${path} is not one of tug's files and ${target} already exists: both kept; merge them by hand and delete ${path}.`);
      continue;
    }
    set(path, null, `moved to ${target}`);
    set(target, reader.read(path), `moved from ${path} (not one of tug's files, so kept as is)`);
    moved.push(path);
  }
  if (moved.length) notes.push(`.agents/tug/ held files that are not tug's: ${moved.join(', ')}; moved under .agents/shiplane/ unchanged.`);
  if (lock?.sha256) {
    const edited = Object.entries(lock.sha256).filter(([p]) => changes.get(p) === null && reader.read(p) != null).map(([p]) => p);
    // The lock's hashes say which files were changed by hand since tug wrote them: their edits are not carried over.
    notes.push(...edited.filter(p => lock.sha256[p] !== shaOf(reader.read(p))).map(p => `${p} was edited by hand after tug wrote it; shiplane's copy replaces it (the edit is in git history).`));
  }
  if (reader.read(LEGACY_LOCK_PATH) != null) set(LEGACY_LOCK_PATH, null, 'tug\'s lock; now .agents/shiplane.lock');

  // 2. Hook configs and hook scripts that run .agents/tug/pre-push.mjs.
  const hookPaths = [...HOOK_FILES.filter(p => reader.exists(p)), ...HOOK_DIRS.flatMap(d => (reader.list?.(d) || []))];
  for (const path of [...new Set(hookPaths)]) {
    if (changes.has(path)) continue;
    const text = reader.read(path);
    if (text == null || !mentionsLegacyPath(text)) continue;
    const next = migrateHookText(text);
    if (next !== text) set(path, next, 'run the gate from .agents/shiplane/ (was .agents/tug/)');
  }

  // 3. .gitignore exceptions (`!.agents/tug/`, `!.agents/tug.lock`).
  const ignore = reader.read('.gitignore');
  if (ignore != null) {
    const next = migrateGitignore(ignore);
    if (next !== ignore) set('.gitignore', next, 'point the .agents/tug/ and .agents/tug.lock rules at .agents/shiplane/ and .agents/shiplane.lock');
  }

  // 4. .agents/config.yml: only its comments name tug (the template's); values are never changed.
  const config = reader.read('.agents/config.yml');
  if (config != null) {
    const next = config.split('\n').map(l => (/^\s*#/.test(l) ? l.replace(/(?<![\w-])tug(?![\w])/g, 'shiplane') : l)).join('\n');
    if (next !== config) set('.agents/config.yml', next, 'its comments name shiplane (were tug); no setting changed');
  }

  const legacyEvents = reader.read(LEGACY_EVENTS_PATH);
  const agents = reader.read('AGENTS.md');
  const found = changes.size > 0 || legacyEvents != null || /<!-- tug:start/.test(agents || '');
  return { changes, why, notes, legacyEvents, found };
}

// sha256 without importing init.mjs (which imports this module).
const shaOf = text => createHash('sha256').update(text).digest('hex');

/**
 * A reader that shows `changes` over `base`: a path mapped to text reads as that text, a path mapped to null is gone.
 * Directory listings follow. The same interface as treeReader / memReader.
 */
export function overlayReader(base, changes) {
  const live = p => changes.has(p) ? changes.get(p) != null : null;
  const added = dir => [...changes.entries()].filter(([p, c]) => c != null && dirname(p) === dir).map(([p]) => p);
  const addedUnder = dir => [...changes.entries()].filter(([p, c]) => c != null && p.startsWith(`${dir}/`)).map(([p]) => p);
  const walk = dir => [...new Set([...blobsUnder(base, dir).filter(p => live(p) !== false), ...addedUnder(dir)])].sort();
  return {
    read: p => (changes.has(p) ? changes.get(p) : base.read(p)),
    exists: p => {
      if (changes.has(p)) return changes.get(p) != null;
      // A directory whose every file was deleted is gone (git has no empty directories).
      if (base.isDir?.(p) || addedUnder(p).length) return walk(p).length > 0;
      return base.exists(p);
    },
    isDir: p => (base.isDir?.(p) || addedUnder(p).length > 0) && walk(p).length > 0,
    list: dir => [...new Set([...(base.list?.(dir) || []).filter(p => live(p) !== false), ...added(dir)])].sort(),
    walk,
    grep: base.grep ? text => base.grep(text).filter(p => live(p) !== false) : undefined,
  };
}

/** Text files (other than the old workflow and the old runtime) that name tug-events.yml: [{ path, content }] with the new name. */
export function eventsMentions(reader) {
  if (!reader.grep) return [];
  return reader.grep('tug-events.yml')
    .filter(p => p !== LEGACY_EVENTS_PATH && !p.startsWith(`${LEGACY_RUNTIME_DIR}/`) && p !== 'AGENTS.md' && p !== '.agents/config.yml')
    .map(p => ({ path: p, before: reader.read(p) }))
    .filter(f => typeof f.before === 'string' && f.before.length < 1_000_000 && !f.before.includes('\u0000'))
    .map(f => ({ path: f.path, content: f.before.replace(/(?<![\w-])tug-events\.yml/g, 'shiplane-events.yml') }))
    .filter(f => f.content !== reader.read(f.path));
}

// ---------------------------------------------------------------------------
// Per machine: the upkeep registry (setup moves it; upkeep still reads it until then)
// ---------------------------------------------------------------------------

const configBase = env => env.XDG_CONFIG_HOME || join(env.HOME, '.config');
/** ~/.config/tug/repos, where tug kept the repos to upkeep. Null without a HOME (never guess a path). */
export function legacyRegistryPath(env = process.env) {
  if (!env.XDG_CONFIG_HOME && !env.HOME) return null;
  return join(configBase(env), LEGACY_NAME, 'repos');
}

/**
 * Move tug's registry into shiplane's: entries merged (shiplane's own entry for a root wins), then the old file removed
 * (and ~/.config/tug/ when it is empty). Returns { moved: n, from, to } or null when there is nothing to move.
 * read/write are registry.mjs's (passed in to keep this module free of a cycle).
 */
export function moveLegacyRegistry({ env = process.env, to, readRegistry, writeRegistry }) {
  const from = legacyRegistryPath(env);
  if (!from || !existsSync(from) || from === to) return null;
  const old = readRegistry(from);
  const current = readRegistry(to);
  const roots = new Set(current.map(e => e.root));
  const merged = [...current, ...old.filter(e => !roots.has(e.root))];
  writeRegistry(merged, to);
  // Read back before deleting the old file: every old root must be in the new one.
  const after = new Set(readRegistry(to).map(e => e.root));
  const lost = old.filter(e => !after.has(e.root));
  if (lost.length) throw new Error(`moving ${from} to ${to} lost ${lost.map(e => e.root).join(', ')}; left ${from} in place`);
  rmSync(from, { force: true });
  try {
    if (!readdirSync(dirname(from)).length) rmdirSync(dirname(from));
  } catch { /* not empty or gone */ }
  return { moved: old.length, from, to };
}

// ---------------------------------------------------------------------------
// doctor: what is left of tug
// ---------------------------------------------------------------------------

/**
 * tug artefacts still here: in the repo (root on disk) and on this machine (user-level hooks, the registry).
 * Returns [{ where: 'repo'|'machine', text, fix }].
 */
export function tugLeftovers({ root, env = process.env, harnesses = [] }) {
  const out = [];
  const repo = (text, fix = 'run shiplane init') => out.push({ where: 'repo', text, fix });
  const readText = p => {
    try {
      return readFileSync(join(root, p), 'utf8');
    } catch {
      return null;
    }
  };
  if (root) {
    if (existsSync(join(root, LEGACY_RUNTIME_DIR))) repo(`${LEGACY_RUNTIME_DIR}/ exists`);
    if (existsSync(join(root, LEGACY_LOCK_PATH))) repo(`${LEGACY_LOCK_PATH} exists`);
    if (existsSync(join(root, LEGACY_EVENTS_PATH))) repo(`${LEGACY_EVENTS_PATH} exists (shiplane init renames it in its events PR)`);
    if (/<!-- tug:start/.test(readText('AGENTS.md') || '')) repo('AGENTS.md has a <!-- tug:start --> block');
    const hookFiles = [...HOOK_FILES, ...HOOK_DIRS.flatMap(d => {
      try {
        return readdirSync(join(root, d)).map(f => `${d}/${f}`);
      } catch {
        return [];
      }
    })];
    for (const p of hookFiles) if (mentionsLegacyPath(readText(p))) repo(`${p} calls ${LEGACY_RUNTIME_DIR}/`);
    for (const p of ['.claude/settings.json', '.codex/hooks.json']) {
      const t = readText(p);
      if (t && (mentionsLegacyPath(t) || hookCommands(t).some(isLegacyGuardCommand))) repo(`${p} runs tug's guard`);
    }
    if (mentionsLegacyPath(migrateGitignoreProbe(readText('.gitignore')))) repo('.gitignore has rules for .agents/tug');
  }
  for (const h of harnesses) {
    let text = null;
    try {
      text = readFileSync(h.path, 'utf8');
    } catch { /* none */ }
    if (text && hookCommands(text).some(isLegacyGuardCommand)) out.push({ where: 'machine', text: `${h.path} runs tug's guard`, fix: 'run shiplane setup first (it replaces the hook, with a backup)' });
    // The agent plugin (skills): setup does not touch plugin settings.
    let plugin = h.name === 'claude' ? text : null;
    if (h.name === 'codex' && h.config) {
      try {
        plugin = readFileSync(h.config, 'utf8');
      } catch { /* none */ }
    }
    if (plugin && /["']tug@tug["']/.test(plugin)) {
      const fix = h.name === 'claude' ? 'after shiplane setup: /plugin marketplace add klovr-co/shiplane, /plugin install shiplane@shiplane, /plugin uninstall tug@tug' : 'after shiplane setup: codex plugin marketplace add klovr-co/shiplane, codex plugin add shiplane@shiplane, then remove [plugins."tug@tug"]';
      out.push({ where: 'machine', text: `${h.name === 'claude' ? h.path : h.config} has the tug@tug plugin`, fix });
    }
  }
  const reg = legacyRegistryPath(env);
  if (reg && existsSync(reg)) out.push({ where: 'machine', text: `${reg} exists`, fix: 'run shiplane setup (it moves it to ~/.config/shiplane/repos)' });
  return out;
}

/** The .gitignore lines (not comments) only, so a comment that mentions .agents/tug is not a leftover. */
const migrateGitignoreProbe = text => (text == null ? null : String(text).split('\n').filter(l => !/^\s*#/.test(l)).join('\n'));

/** Every hook command string in a settings/hooks JSON text ([] when it does not parse). */
export function hookCommands(text) {
  const out = [];
  try {
    const s = JSON.parse(text);
    for (const groups of Object.values(s?.hooks || {})) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups) for (const h of g?.hooks || []) if (typeof h?.command === 'string') out.push(h.command);
    }
  } catch { /* not JSON */ }
  return out;
}
