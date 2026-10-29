// Rendering tug's templates from .agents/config.yml, and updating files tug shares with the repo (AGENTS.md, the config).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, parseConfig, shipBranch } from './config.mjs';
import { parseYaml, yamlScalar } from './yaml.mjs';
import { VERSION } from './version.mjs';

export const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
export const template = name => readFileSync(join(TEMPLATES, name), 'utf8');

/** Replace {{name}} (word characters only, so GitHub's `${{ expr }}` is never touched). Unknown names throw. */
export function render(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error(`template variable {{${name}}} has no value`);
    return String(vars[name]);
  });
}

/** A YAML block list placed right after `key:` (" []" when empty). */
function yamlList(items, indent) {
  if (!items?.length) return ' []';
  const pad = ' '.repeat(indent);
  return items
    .map(item => {
      if (item !== null && typeof item === 'object') {
        const [first, ...rest] = Object.entries(item);
        return [`\n${pad}- ${first[0]}: ${yamlScalar(first[1])}`, ...rest.map(([k, v]) => `\n${pad}  ${k}: ${yamlScalar(v)}`)].join('');
      }
      return `\n${pad}- ${yamlScalar(item)}`;
    })
    .join('');
}

/** .agents/config.yml text for a config (defaults for anything missing). */
export function renderConfig(config = DEFAULTS) {
  const c = { ...DEFAULTS, ...config, branches: { ...DEFAULTS.branches, ...config.branches }, needsOwner: { ...DEFAULTS.needsOwner, ...config.needsOwner } };
  return render(template('agents/config.yml'), {
    shipTarget: yamlScalar(c.shipTarget),
    production: yamlScalar(c.branches.production),
    staging: yamlScalar(c.branches.staging),
    needsOwnerPaths: yamlList(c.needsOwner.paths, 4),
    needsOwnerCategories: yamlList(c.needsOwner.categories, 4),
    checkCommand: yamlScalar(c.checkCommand),
    installCommand: yamlScalar(c.installCommand),
    generated: yamlList(c.generated, 2),
    deployWorkflows: yamlList(c.deployWorkflows, 2),
    liveUrl: yamlScalar(c.liveUrl),
    mergeMethod: yamlScalar(c.mergeMethod),
    ciCheck: yamlScalar(c.ciCheck),
  });
}

/** Top-level sections of rendered config text: [{ key, text }] where text holds the key's comments and lines. */
function sections(text) {
  const out = [];
  let pending = [];
  for (const line of text.split('\n')) {
    const key = /^([A-Za-z_][\w-]*):/.exec(line)?.[1];
    if (key) {
      out.push({ key, lines: [...pending, line] });
      pending = [];
    } else if (/^\s+\S/.test(line) && out.length && !pending.length) out[out.length - 1].lines.push(line);
    else pending.push(line);
  }
  return out.map(({ key, lines }) => ({ key, text: lines.join('\n').replace(/^\n+/, '') }));
}

/**
 * An existing config with every missing top-level key appended (with the template's comment), the user's own
 * keys and comments untouched. Returns { text, added }.
 */
export function addMissingConfigKeys(existing, defaults = DEFAULTS) {
  const have = parseYaml(existing) || {};
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const missing = sections(renderConfig(defaults)).filter(s => !Object.prototype.hasOwnProperty.call(have, s.key));
  if (!missing.length) return { text: existing, added: [] };
  const lf = existing.replace(/\r\n/g, '\n');
  const body = `${lf.replace(/\n*$/, '\n')}\n${missing.map(s => s.text).join('\n\n')}\n`;
  const text = eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body;
  parseConfig(text); // the result must still read
  return { text, added: missing.map(s => s.key) };
}

// ---------------------------------------------------------------------------
// AGENTS.md block
// ---------------------------------------------------------------------------

const START = /<!-- tug:start(?: v([^\s>]+))? -->/g;
const END = '<!-- tug:end -->';

/** The AGENTS.md block for this kit version and ship branch (LF line endings). */
export function renderAgentsBlock(config, version = VERSION) {
  return render(template('AGENTS-block.md'), { version, shipBranch: shipBranch(config) }).replace(/\n+$/, '');
}

/** The version in an AGENTS.md block, or null when there is none. Throws on broken markers. */
export function agentsBlockVersion(text) {
  const found = findBlock(text);
  return found ? found.version : null;
}

function findBlock(text) {
  const starts = [...String(text).matchAll(START)];
  if (!starts.length) {
    if (String(text).includes(END)) throw new Error('AGENTS.md has <!-- tug:end --> without <!-- tug:start -->; fix the markers by hand');
    return null;
  }
  if (starts.length > 1) throw new Error('AGENTS.md has more than one <!-- tug:start --> marker; keep one block');
  const start = starts[0].index;
  const end = text.indexOf(END, start);
  if (end < 0) throw new Error('AGENTS.md has <!-- tug:start --> without <!-- tug:end -->; fix the markers by hand');
  if (text.indexOf(END, end + END.length) >= 0) throw new Error('AGENTS.md has more than one <!-- tug:end --> marker; keep one block');
  return { start, end: end + END.length, version: starts[0][1] ?? null };
}

/**
 * AGENTS.md with the tug block replaced (or appended), everything outside the markers byte-for-byte the same.
 * The block takes the file's line endings (CRLF file -> CRLF block), so the line-ending check stays green.
 */
export function upsertAgentsBlock(existing, block) {
  if (existing == null || existing === '') return `${block}\n`;
  const crlf = existing.includes('\r\n') && !/(^|[^\r])\n/.test(existing);
  const styled = crlf ? block.replace(/\r?\n/g, '\r\n') : block.replace(/\r\n/g, '\n');
  const found = findBlock(existing);
  if (found) return existing.slice(0, found.start) + styled + existing.slice(found.end);
  const eol = crlf ? '\r\n' : '\n';
  const trimmed = existing.replace(/(\r?\n)*$/, '');
  return `${trimmed}${eol}${eol}${styled}${eol}`;
}

// ---------------------------------------------------------------------------
// Mergify
// ---------------------------------------------------------------------------

export function renderMergify(config, version = VERSION) {
  return render(template('mergify.yml'), {
    version,
    base: shipBranch(config),
    mergeMethod: config.mergeMethod,
    mergeCondition: yamlScalar(`check-success = ${config.ciCheck}`),
  });
}

const norm = s => s.replace(/\s+/g, '');

/**
 * Which queue rules let a PR labelled hold or needs-owner in: [{ rule, missing: [labels] }]. Empty = all block both.
 * Only top-level conditions count: one inside an or: group does not reliably block.
 */
export function mergifyLeaks(text) {
  const doc = parseYaml(text) || {};
  const rules = Array.isArray(doc.queue_rules) ? doc.queue_rules : [];
  if (!rules.length) return [{ rule: '(no queue_rules)', missing: ['hold', 'needs-owner'] }];
  const leaks = [];
  for (const rule of rules) {
    const top = (rule.queue_conditions || []).filter(c => typeof c === 'string').map(norm);
    const missing = ['hold', 'needs-owner'].filter(label => !top.includes(norm(`-label = ${label}`)) && !top.includes(norm(`-label=${label}`)));
    if (missing.length) leaks.push({ rule: rule.name || '(unnamed)', missing });
  }
  return leaks;
}
