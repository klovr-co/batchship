// The turn-end guard's adapters: a Stop hook in Claude Code (settings.json) and in Codex (hooks.json). Both take the
// same contract: the payload on stdin, {"decision":"block","reason":...} on stdout to keep the agent going.
// Installing merges into the user's file (never replaces it), then reads it back to check that every hook that was
// there is still there.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TUG_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tug.mjs');
const HOOK_TIMEOUT_S = 30;
const home = env => env.HOME || homedir();

/** The harnesses tug knows, with where their user-level hook config lives. */
export function harnesses(env = process.env) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home(env), '.claude');
  const codexDir = env.CODEX_HOME || join(home(env), '.codex');
  return [
    { name: 'claude', label: 'Claude Code', dir: claudeDir, path: join(claudeDir, 'settings.json') },
    { name: 'codex', label: 'Codex', dir: codexDir, path: join(codexDir, 'hooks.json'), config: join(codexDir, 'config.toml') },
  ];
}

/** Harnesses present on this machine (their config directory exists). */
export const detectHarnesses = (env = process.env) => harnesses(env).filter(h => existsSync(h.dir));

const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The hook command: this node and this tug, by absolute path (a hook's PATH may not have them). */
export function guardCommand(harness, { node = process.execPath, bin = TUG_BIN } = {}) {
  let real = bin;
  try {
    real = realpathSync(bin);
  } catch { /* keep as given */ }
  return `${sq(node)} ${sq(real)} guard --hook ${harness}`;
}

/** True for a hook command that runs tug guard (any path, any version). */
export const isGuardCommand = command => typeof command === 'string' && /tug(?:\.mjs)?'?\s+guard\b/.test(command);

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every handler in a hooks map, as JSON strings: [event, json]. */
function handlers(hooks) {
  const out = [];
  for (const [event, groups] of Object.entries(isObject(hooks) ? hooks : {})) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) for (const h of (isObject(g) && Array.isArray(g.hooks) ? g.hooks : [])) out.push(`${event}\u0000${JSON.stringify(h)}`);
  }
  return out;
}

/**
 * Settings with the guard as a Stop hook. Pure. Keeps every other key and hook; an existing tug guard hook gets the
 * new command in place. Throws when the file's hooks are not the shape the harness documents.
 */
export function mergeGuardHook(settings, command) {
  const out = settings == null ? {} : JSON.parse(JSON.stringify(settings));
  if (!isObject(out)) throw new Error('the file is not a JSON object');
  if (out.hooks === undefined) out.hooks = {};
  if (!isObject(out.hooks)) throw new Error('"hooks" is not an object');
  if (out.hooks.Stop === undefined) out.hooks.Stop = [];
  if (!Array.isArray(out.hooks.Stop)) throw new Error('"hooks.Stop" is not a list');
  let found = false;
  let changed = false;
  for (const group of out.hooks.Stop) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    group.hooks = group.hooks.filter(h => {
      if (!isObject(h) || !isGuardCommand(h.command)) return true;
      if (found) {
        changed = true; // a second copy would race the first on the counter file
        return false;
      }
      found = true;
      if (h.command !== command) {
        h.command = command;
        changed = true;
      }
      return true;
    });
  }
  out.hooks.Stop = out.hooks.Stop.filter(g => !isObject(g) || !Array.isArray(g.hooks) || g.hooks.length);
  if (!found) {
    out.hooks.Stop.push({ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] });
    changed = true;
  }
  return { settings: out, changed };
}

/** The guard command installed in a harness's file, or null (also null when the file is missing or unreadable). */
export function installedGuard(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    for (const g of s?.hooks?.Stop || []) for (const h of g?.hooks || []) if (isGuardCommand(h?.command)) return h.command;
  } catch { /* none */ }
  return null;
}

/**
 * Install the guard into one harness's file: merge, write through a temp file, read back, and check that the guard
 * is there and every earlier hook survived (else restore the backup). Returns { changed, path, backup }.
 */
export function installGuard(harness, { command = guardCommand(harness.name) } = {}) {
  let path = harness.path;
  // Write through a symlink (dotfiles), not over it.
  try {
    path = realpathSync(path);
  } catch { /* no file yet */ }
  let before = null;
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    if (text.trim()) {
      try {
        before = JSON.parse(text);
      } catch (err) {
        throw new Error(`${path} is not valid JSON (${err.message}); left alone: fix it, then run tug setup again`);
      }
    }
  }
  const { settings, changed } = mergeGuardHook(before, command);
  if (!changed) return { changed: false, path, backup: null };
  mkdirSync(dirname(path), { recursive: true });
  // The backup is the file as it was before tug first touched it: never overwritten.
  const existed = existsSync(path);
  const backup = existed ? `${path}.tug-backup` : null;
  if (backup && !existsSync(backup)) copyFileSync(path, backup);
  const restore = existed ? readFileSync(path) : null;
  const mode = existed ? statSync(path).mode & 0o777 : 0o644;
  const tmp = `${path}.tug-${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  let ok = false;
  try {
    const after = JSON.parse(readFileSync(path, 'utf8'));
    const kept = handlers(after.hooks);
    const lost = handlers(before?.hooks).filter(h => !isGuardCommand(JSON.parse(h.split('\u0000')[1]).command) && !kept.includes(h));
    const otherKeys = Object.keys(before || {}).filter(k => k !== 'hooks' && JSON.stringify(after[k]) !== JSON.stringify(before[k]));
    ok = installedGuard(path) === command && !lost.length && !otherKeys.length;
  } catch { /* ok stays false */ }
  if (!ok) {
    if (restore) writeFileSync(path, restore);
    else rmSync(path, { force: true });
    throw new Error(`${path}: the merged file did not read back as expected; ${restore ? 'restored the original' : 'removed it again'}`);
  }
  return { changed: true, path, backup };
}

/** Codex turns hooks off with `hooks = false` (or the old `codex_hooks = false`) under [features] in config.toml. */
export function codexHooksDisabled(configText) {
  let section = '';
  for (const raw of String(configText || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) section = head[1].trim();
    else if (section === 'features' && /^(hooks|codex_hooks)\s*=\s*false$/.test(line)) return true;
  }
  return false;
}

/** Run an installed guard command with a probe payload: { ok, detail }. */
export function probeGuard(command, { cwd, env = process.env } = {}) {
  const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 'tug-doctor-probe', cwd, stop_hook_active: false, last_assistant_message: '', tug_probe: true });
  const r = spawnSync('/bin/sh', ['-c', command], { cwd, env, input: payload, encoding: 'utf8', timeout: 15_000 });
  if (r.error) return { ok: false, detail: r.error.message };
  if (r.status === 0 && /"tug_probe":"ok"/.test(r.stdout)) return { ok: true, detail: 'fires (probe answered)' };
  return { ok: false, detail: `exit ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n')[0] || 'no output'}` };
}

/** Doctor's view of every harness: [{ name, ok, detail }]. */
export function guardHookChecks({ cwd, env = process.env, probe = probeGuard } = {}) {
  const out = [];
  for (const h of harnesses(env)) {
    if (!existsSync(h.dir)) continue;
    const command = installedGuard(h.path);
    if (!command) {
      out.push({ name: `guard hook (${h.label})`, ok: false, detail: `not installed in ${h.path}: run tug setup` });
      continue;
    }
    if (h.name === 'codex' && existsSync(h.config) && codexHooksDisabled(readFileSync(h.config, 'utf8'))) {
      out.push({ name: `guard hook (${h.label})`, ok: false, detail: `installed, but hooks are off in ${h.config} ([features] hooks = false)` });
      continue;
    }
    const p = probe(command, { cwd, env });
    const trust = h.name === 'codex' ? '; Codex runs it only after you trust it once (/hooks)' : '';
    out.push({ name: `guard hook (${h.label})`, ok: p.ok, detail: `${p.ok ? 'installed and fires' : `installed but does not run: ${p.detail}; run tug setup again`}${trust}` });
  }
  return out;
}
