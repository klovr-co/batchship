// Part of tug. `tug init` copies this file into .agents/tug/; edit it in the tug repo, not there.
// .agents/config.yml: the settings every agent and every tug command reads.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml.mjs';

export const CONFIG_PATH = '.agents/config.yml';

export const DEFAULTS = Object.freeze({
  shipTarget: 'production',
  branches: { production: 'main', staging: null },
  needsOwner: {
    paths: ['.github/**', '.mergify.yml', '.agents/**', '.githooks/**', 'AGENTS.md', 'CLAUDE.md'],
    categories: [
      'production data (migrations, backfills, deletes)',
      'anything that sends real messages or moves money',
      'secrets, auth, billing or permission settings',
    ],
  },
  checkCommand: null,
  installCommand: null,
  generated: [],
  deployWorkflows: [],
  liveUrl: null,
  mergeMethod: 'squash',
  ciCheck: 'CI gate',
});

const TARGETS = ['production', 'staging'];
const METHODS = ['merge', 'squash', 'rebase'];

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => JSON.parse(JSON.stringify(v));

/** Settings from config text, with defaults for missing keys. Throws on a value tug cannot use. */
export function parseConfig(text) {
  const raw = text == null ? {} : parseYaml(text);
  if (!isObject(raw)) throw new Error(`${CONFIG_PATH}: expected a map of settings`);
  const config = clone(DEFAULTS);
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'branches' || key === 'needsOwner') {
      if (value === null) continue;
      if (!isObject(value)) throw new Error(`${CONFIG_PATH}: ${key} must be a map`);
      config[key] = { ...config[key], ...value };
    } else config[key] = value;
  }
  if (!TARGETS.includes(config.shipTarget)) throw new Error(`${CONFIG_PATH}: shipTarget must be production or staging, not ${JSON.stringify(config.shipTarget)}`);
  if (!METHODS.includes(config.mergeMethod)) throw new Error(`${CONFIG_PATH}: mergeMethod must be one of ${METHODS.join(', ')}`);
  for (const key of ['deployWorkflows', 'generated']) {
    if (config[key] === null) config[key] = [];
    if (!Array.isArray(config[key])) throw new Error(`${CONFIG_PATH}: ${key} must be a list`);
  }
  config.generated = config.generated.map(g => (typeof g === 'string' ? { run: g } : g));
  for (const g of config.generated) if (!isObject(g) || typeof g.run !== 'string' || !g.run.trim()) throw new Error(`${CONFIG_PATH}: each generated entry needs run: <command>`);
  for (const key of ['paths', 'categories']) {
    if (config.needsOwner[key] === null || config.needsOwner[key] === undefined) config.needsOwner[key] = [];
    if (!Array.isArray(config.needsOwner[key])) throw new Error(`${CONFIG_PATH}: needsOwner.${key} must be a list`);
  }
  if (typeof config.ciCheck !== 'string' || !config.ciCheck.trim()) throw new Error(`${CONFIG_PATH}: ciCheck must name the check the merge queue waits for`);
  return config;
}

/** The repo's config, or the defaults when the file is missing. */
export function loadConfig(root) {
  const path = join(root, CONFIG_PATH);
  return parseConfig(existsSync(path) ? readFileSync(path, 'utf8') : null);
}

/** The branch "ship" merges into: branches[shipTarget]. Throws when it is not set. */
export function shipBranch(config) {
  const branch = config.branches?.[config.shipTarget];
  if (!branch || typeof branch !== 'string') throw new Error(`${CONFIG_PATH}: shipTarget is ${config.shipTarget} but branches.${config.shipTarget} is not set; set it or change shipTarget`);
  return branch;
}

/** A glob (`**`, `*`, `?`) as a RegExp over repo-relative paths. A pattern without a slash matches at any depth. */
export function globToRegExp(glob) {
  let g = String(glob).replace(/^\.\//, '');
  const anchored = g.includes('/') && !g.startsWith('**/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(anchored ? `^${re}$` : `^(?:.*/)?${re.replace(/^\(\?:\.\*\/\)\?/, '')}$`);
}

/** Changed paths that match needsOwner.paths. */
export function needsOwnerMatches(config, files) {
  const patterns = (config.needsOwner?.paths || []).map(globToRegExp);
  return files.filter(file => patterns.some(re => re.test(file)));
}
