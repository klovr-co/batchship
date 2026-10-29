// Rendering tug's templates from .agents/config.yml, and updating files tug shares with the repo (AGENTS.md, the config).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, parseConfig, shipBranch } from './config.mjs';
import { parseYaml, yamlScalar } from './yaml.mjs';
import { deployJobsSkipped } from './ship.mjs';
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
    owners: yamlList(c.owners, 2),
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

// ---------------------------------------------------------------------------
// The tug events workflow (.github/workflows/tug-events.yml)
// ---------------------------------------------------------------------------

export const EVENTS_PATH = '.github/workflows/tug-events.yml';
/** actions/github-script v8.0.0, pinned by its full commit SHA. */
export const GITHUB_SCRIPT = 'ed597411d8f924073f98dfc5c65a23a2325f34cd # v8.0.0';
/** The cheapest GitHub-hosted runner (1 vCPU; a job here takes seconds). */
export const EVENTS_RUNNER = 'ubuntu-slim';

/** A workflow's top-level `name:`, or null (GitHub then names it by its path). Reads the line, not the whole file. */
export function workflowName(text) {
  const m = /^name:[ \t]*(.*)$/m.exec(String(text || '').replace(/\r\n/g, '\n'));
  if (!m) return null;
  try {
    const v = parseYaml(`name: ${m[1]}`).name;
    return v == null || v === '' ? null : String(v);
  } catch {
    return null;
  }
}

/** The workflow that runs the CI gate job (a job named ciCheck), or null. workflows: [{ path, text }]. */
export function ciWorkflow(workflows, ciCheck) {
  const esc = String(ciCheck).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s+name:\\s*(?:${esc}|"${esc}"|'${esc}')\\s*(?:#.*)?$`, 'm');
  return workflows.find(w => w.path !== EVENTS_PATH && re.test(String(w.text || '').replace(/\r\n/g, '\n'))) || null;
}

/** A string as a GitHub expression literal. */
const exprString = s => `'${String(s).replace(/'/g, "''")}'`;

/**
 * The events workflow for a config. workflows: [{ path, text }] from .github/workflows/ (each deploy workflow's
 * `name:` is what workflow_run matches). Every config value goes into a double-quoted env value or expression literal;
 * a value containing `${{` is refused, because GitHub would evaluate it.
 */
export function renderEvents(config, workflows = [], version = VERSION) {
  const byFile = new Map(workflows.map(w => [w.path.split('/').pop(), w]));
  const nameOf = file => {
    const w = byFile.get(String(file).split('/').pop());
    return (w && workflowName(w.text)) || `.github/workflows/${String(file).split('/').pop()}`;
  };
  const deployNames = [...new Set((config.deployWorkflows || []).map(nameOf))];
  const deployFiles = new Set((config.deployWorkflows || []).map(f => String(f).split('/').pop()));
  const ci = ciWorkflow(workflows.filter(w => !deployFiles.has(w.path.split('/').pop())), config.ciCheck);
  const ciName = ci ? workflowName(ci.text) || ci.path : null;
  const branch = shipBranch(config);
  const values = [...deployNames, ciName, branch, config.liveUrl, ...(config.owners || [])].filter(v => v != null);
  const bad = values.find(v => String(v).includes('${{'));
  if (bad != null) throw new Error(`tug events: ${JSON.stringify(bad)} contains "\${{", which GitHub would evaluate; rename it`);
  const watched = [...deployNames, ...(ciName ? [ciName] : [])];
  const workflowRun = watched.length ? `  workflow_run:\n    workflows:\n${watched.map(n => `      - ${JSON.stringify(n)}`).join('\n')}\n    types: [completed]\n` : '';
  const fn = deployJobsSkipped.toString().replace(/\n/g, '\n            ');
  return render(template('github/tug-events.yml'), {
    version,
    shipBranch: branch.replace(/[\r\n]/g, ' '),
    workflowRun,
    runner: EVENTS_RUNNER,
    githubScript: GITHUB_SCRIPT,
    owners: JSON.stringify(JSON.stringify(config.owners || [])),
    deployIf: JSON.stringify(`github.event_name == 'workflow_run' && contains(fromJSON(${exprString(JSON.stringify(deployNames))}), github.event.workflow_run.name)`),
    liveIf: JSON.stringify(ciName ? `github.event_name == 'workflow_run' && github.event.workflow_run.name == ${exprString(ciName)}` : 'false'),
    shipBranchValue: JSON.stringify(branch),
    liveUrl: JSON.stringify(String(config.liveUrl ?? '')),
    manyDeploys: JSON.stringify(String(deployNames.length > 1)),
    deployJobsSkipped: fn,
  });
}
