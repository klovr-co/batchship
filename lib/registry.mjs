// ~/.config/shiplane/repos: the repos this machine keeps up (shiplane setup adds, shiplane upkeep reads). One per line:
// "<root checkout path> <ship branch> <owner/name>".
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { legacyRegistryPath } from './migrate.mjs';

export function registryPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  return join(base, 'shiplane', 'repos');
}

export function parseRegistry(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const parts = l.split(/\s+/);
      const [slug, base] = [parts.pop(), parts.pop()];
      return { root: parts.join(' '), base, slug };
    })
    .filter(e => e.root && e.base && e.slug);
}

export function readRegistry(path = registryPath()) {
  return existsSync(path) ? parseRegistry(readFileSync(path, 'utf8')) : [];
}

/** The repos upkeep runs over: shiplane's registry, plus tug's (~/.config/tug/repos) until shiplane setup moves it. */
export function upkeepEntries(env = process.env) {
  const own = readRegistry(registryPath(env));
  const legacy = legacyRegistryPath(env);
  const roots = new Set(own.map(e => e.root));
  return [...own, ...(legacy ? readRegistry(legacy).filter(e => !roots.has(e.root)) : [])];
}

const HEADER = '# shiplane upkeep: <root checkout> <ship branch> <owner/name>\n';
const format = entries => `${HEADER}${entries.map(e => `${e.root} ${e.base} ${e.slug}`).join('\n')}\n`;

/** Write the whole registry. */
export function writeRegistry(entries, path = registryPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, format(entries));
}

/** Add or update a repo's entry (keyed by root). Returns true when the file changed. */
export function register(entry, path = registryPath()) {
  const entries = readRegistry(path).filter(e => e.root !== entry.root);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  entries.push(entry);
  const text = format(entries);
  if (text === before) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}
