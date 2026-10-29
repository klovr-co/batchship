// tug init: bring a repo onto the shared delivery flow, as one PR. planInit() is pure (tests drive it with a fake
// reader); applyInit() reads the ship branch from origin, writes the plan in a temporary worktree, and opens the PR.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_PATH, DEFAULTS, parseConfig, shipBranch } from './config.mjs';
import { git, gitOk, tryGit } from './git.mjs';
import { createClient, repoInfo } from './gh.mjs';
import { detectHookManager, wireHook } from './hooks.mjs';
import { addMissingConfigKeys, agentsBlockVersion, mergifyLeaks, renderAgentsBlock, renderConfig, renderMergify, template, upsertAgentsBlock } from './render.mjs';
import { VERSION } from './version.mjs';

const LIB = dirname(fileURLToPath(import.meta.url));
/** Files copied into .agents/tug/ so the pre-push gate runs without tug installed. */
export const RUNTIME_FILES = ['git.mjs', 'yaml.mjs', 'config.mjs', 'pm.mjs', 'pre-push.mjs', 'checks/line-endings.mjs', 'checks/generated-current.mjs'];
export const LOCK_PATH = '.agents/tug.lock';
export const MERGIFY_PATHS = ['.mergify.yml', '.mergify/config.yml', '.github/mergify.yml'];
export const LABELS = [
  { name: 'queue', color: '0e8a16', description: 'Ship it: Mergify queues it (with a comment that is exactly @mergifyio queue)' },
  { name: 'hotfix', color: 'd93f0b', description: 'Ship now: front of the queue, alone; interrupts the running batch' },
  { name: 'hold', color: 'fbca04', description: 'Not now: keeps the PR out of the merge queue' },
  { name: 'needs-owner', color: '5319e7', description: 'Waits for the owner\'s yes (first line: "Needs owner: <the decision>")' },
  { name: 'approved', color: '0052cc', description: 'The owner approved a change that needed their yes' },
  { name: 'full-ci', color: 'c5def5', description: 'Run every CI check on the queue batch that contains this PR' },
];

const runtimeSource = file => readFileSync(join(LIB, file), 'utf8');

/** Reads files at a git ref (no checkout): { read, exists, isDir, list }. */
export function treeReader(root, ref) {
  const entries = new Map();
  const out = tryGit(root, ['ls-tree', '-r', '-t', '-z', '--full-tree', ref]) ?? '';
  for (const entry of out.split('\0').filter(Boolean)) {
    const [meta, path] = entry.split('\t');
    entries.set(path, meta.split(' ')[1]);
  }
  return {
    read: path => (entries.get(path) === 'blob' ? git(root, ['show', `${ref}:${path}`]) : null),
    exists: path => entries.has(path),
    isDir: path => entries.get(path) === 'tree',
    list: dir => [...entries.keys()].filter(p => dirname(p) === dir && entries.get(p) === 'blob'),
  };
}

/** A starting config for a repo that has none: production = its default branch; deploy workflows by name. */
export function guessConfig(reader, defaultBranch) {
  const workflows = (reader.list?.('.github/workflows') || []).map(p => p.split('/').pop());
  return {
    ...JSON.parse(JSON.stringify(DEFAULTS)),
    branches: { production: defaultBranch || 'main', staging: null },
    deployWorkflows: workflows.filter(name => /deploy|release|publish/i.test(name) && /\.ya?ml$/.test(name)),
  };
}

/**
 * The change set: { config, files: [{ path, content, mode?, action: create|update, why }], skipped: [{ path, why }],
 * labels: [names to create], defaultBranch: { from, to } | null, notes: [text] }.
 */
export function planInit({ reader, defaultBranch, existingLabels = null, force = false, version = VERSION }) {
  const files = [];
  const skipped = [];
  const notes = [];
  const put = (path, content, why, mode) => {
    const before = reader.read(path);
    if (before === content) return;
    files.push({ path, content, mode, action: before == null ? 'create' : 'update', why });
  };

  // 1. The config: add missing keys to an existing one, never change a value.
  const configText = reader.read(CONFIG_PATH);
  let config;
  if (configText != null) {
    config = parseConfig(configText);
    const { text, added } = addMissingConfigKeys(configText);
    if (added.length) put(CONFIG_PATH, text, `add missing settings: ${added.join(', ')}`);
  } else {
    config = parseConfig(renderConfig(guessConfig(reader, defaultBranch)));
    put(CONFIG_PATH, renderConfig(config), 'settings every agent and tug command reads');
    notes.push(`New ${CONFIG_PATH}: check shipTarget, branches, deployWorkflows, liveUrl and checkCommand in the PR.`);
  }
  const branch = shipBranch(config);

  // 2. AGENTS.md: the block between the markers; everything else stays as it is.
  const agents = reader.read('AGENTS.md');
  const block = renderAgentsBlock(config, version);
  put('AGENTS.md', upsertAgentsBlock(agents, block), agents == null ? 'the shipping rules agents follow' : agentsBlockVersion(agents) ? 'update the tug block' : 'add the tug block (the rest of the file is unchanged)');
  const claude = reader.read('CLAUDE.md');
  if (claude != null && !claude.includes('AGENTS.md')) {
    const eol = claude.includes('\r\n') ? '\r\n' : '\n';
    put('CLAUDE.md', `${claude.replace(/(\r?\n)*$/, '')}${eol}${eol}@AGENTS.md${eol}`, 'Claude Code reads CLAUDE.md, not AGENTS.md');
  }

  // 3. The gate's code, so the hook runs without tug installed.
  for (const file of RUNTIME_FILES) put(`.agents/tug/${file}`, runtimeSource(file), 'the pre-push gate');

  // 4. Hook wiring: into the repo's hook manager when it has one, else .githooks/pre-push.
  const detected = detectHookManager(reader);
  const wiring = wireHook(detected, reader, { template: template('githooks/pre-push'), force });
  if (wiring.path) put(wiring.path, wiring.content, detected.manager === 'githooks' ? 'pre-push hook (on per machine: tug setup)' : `run the gate from ${detected.manager}'s pre-push`, wiring.mode);
  else if (wiring.manual) skipped.push({ path: detected.file, why: wiring.manual });

  // 5. Mergify: tug's file, or a report on the repo's own.
  const mergifyPath = MERGIFY_PATHS.find(p => reader.exists(p));
  const mergifyText = mergifyPath ? reader.read(mergifyPath) : null;
  const rendered = renderMergify(config, version);
  if (!mergifyPath) put('.mergify.yml', rendered, 'merge queue: default and hotfix queues; hold and needs-owner block');
  else if (/^# Managed by tug/.test(mergifyText) || force) put(mergifyPath, rendered, force && !/^# Managed by tug/.test(mergifyText) ? 'replace with tug\'s (--force)' : 'update tug\'s merge queue config');
  else {
    let leaks = [];
    try {
      leaks = mergifyLeaks(mergifyText);
    } catch (err) {
      leaks = [{ rule: `(could not read: ${err.message})`, missing: ['hold', 'needs-owner'] }];
    }
    const why = leaks.length
      ? `kept the repo's own file; these queue rules do not block hold/needs-owner: ${leaks.map(l => `${l.rule} (add ${l.missing.map(m => `\`-label = ${m}\``).join(', ')})`).join('; ')}. Or replace it with tug's: tug init --force`
      : "kept the repo's own file (it blocks hold and needs-owner)";
    skipped.push({ path: mergifyPath, why });
  }

  // 6. The lock: which kit version wrote these files.
  const managed = [...files.map(f => f.path)].filter(p => p !== CONFIG_PATH && p !== 'AGENTS.md' && p !== 'CLAUDE.md');
  const lock = `${JSON.stringify({ version, files: [...new Set([...managed, ...RUNTIME_FILES.map(f => `.agents/tug/${f}`)])].sort() }, null, 2)}\n`;
  const oldLock = reader.read(LOCK_PATH);
  let oldVersion = null;
  try {
    oldVersion = JSON.parse(oldLock || 'null')?.version ?? null;
  } catch { /* unreadable: rewrite */ }
  if (files.length || oldVersion !== version) put(LOCK_PATH, lock, `kit version ${version}`);

  // 7. Outside the tree.
  const labels = existingLabels === null ? LABELS.map(l => l.name) : LABELS.map(l => l.name).filter(n => !existingLabels.includes(n));
  const defaultChange = defaultBranch && defaultBranch !== branch ? { from: defaultBranch, to: branch } : null;
  const workflows = (reader.list?.('.github/workflows') || []).filter(p => /\.ya?ml$/.test(p));
  if (!workflows.length) notes.push('No CI workflow: the adopt skill proposes templates/ci/starter-pnpm.yml or starter-bun.yml.');
  else if (!workflows.some(p => (reader.read(p) || '').includes('mergify/merge-queue/'))) notes.push(`CI runs on every PR: no workflow gates on mergify/merge-queue/*. The adopt skill fits templates/ci/gate.snippet.yml into it as its own PR; until then the queue waits for a check named "${config.ciCheck}".`);
  if (!config.checkCommand) notes.push('checkCommand is not set: the gate runs only tug\'s own checks. The adopt skill writes the repo\'s.');
  return { config, branch, files, skipped, labels, defaultBranch: defaultChange, notes };
}

export function formatPlan(plan, { slug } = {}) {
  const lines = [`tug init${slug ? ` ${slug}` : ''} (ship branch ${plan.branch}, kit ${VERSION})`];
  if (plan.files.length) {
    lines.push('Files, in one PR into ' + plan.branch + ':');
    for (const f of plan.files) lines.push(`  ${f.action.padEnd(6)} ${f.path}  (${f.why})`);
  } else lines.push('Files: nothing to change');
  for (const s of plan.skipped) lines.push(`  left   ${s.path}: ${s.why}`);
  lines.push(plan.labels.length ? `Labels to create: ${plan.labels.join(', ')}` : 'Labels: all present');
  lines.push(plan.defaultBranch ? `Default branch: ${plan.defaultBranch.from} -> ${plan.defaultBranch.to} (Mergify reads its config from the default branch)` : `Default branch: ${plan.branch} (ok)`);
  for (const n of plan.notes) lines.push(`Note: ${n}`);
  return lines.join('\n');
}

function prBody(plan) {
  return [
    `Needs owner: adopt tug ${VERSION}'s delivery flow (it changes AGENTS.md and the merge queue config).`,
    '',
    'Written by `tug init`:',
    ...plan.files.map(f => `- ${f.action} \`${f.path}\`: ${f.why}`),
    ...plan.skipped.map(s => `- left \`${s.path}\`: ${s.why}`),
    '',
    ...plan.notes.map(n => `- ${n}`),
    '',
    'After merging, each machine runs `tug setup` once (turns on the pre-push gate, registers the repo for upkeep).',
  ].join('\n');
}

/** Run init in the repo containing cwd. Returns an exit code. */
export async function applyInit({ cwd = process.cwd(), dryRun = false, force = false, log = console.log, client: givenClient } = {}) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const info = repoInfo(root);
  const client = givenClient || createClient(info.slug);
  // The config lives on the ship branch, which the config names: read the local copy (or the default branch's) first.
  git(root, ['fetch', '-q', 'origin']);
  const startRef = `origin/${info.defaultBranch}`;
  const localConfig = tryGit(root, ['show', `HEAD:${CONFIG_PATH}`]) ?? tryGit(root, ['show', `${startRef}:${CONFIG_PATH}`]);
  const branch = localConfig ? shipBranch(parseConfig(localConfig)) : info.defaultBranch;
  const ref = `origin/${branch}`;
  if (!gitOk(root, ['rev-parse', '--verify', '--quiet', ref])) throw new Error(`no ${ref}: push the ship branch first`);
  const plan = planInit({ reader: treeReader(root, ref), defaultBranch: info.defaultBranch, existingLabels: client.labels(), force });
  log(formatPlan(plan, { slug: info.slug }));
  if (dryRun) {
    log('\n--dry-run: nothing changed.');
    return 0;
  }
  for (const name of plan.labels) {
    client.createLabel(LABELS.find(l => l.name === name));
    log(`created label ${name}`);
  }
  if (plan.files.length) {
    let head = `tug/init-v${VERSION}`;
    if (tryGit(root, ['ls-remote', '--heads', 'origin', head])) head = `${head}-${new Date().toISOString().slice(0, 16).replace(/\D/g, '')}`;
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tug-init-')));
    if (!scratch.startsWith(realpathSync(tmpdir()) + sep)) throw new Error(`refusing to use ${scratch}: not under the temp dir`);
    const tree = join(scratch, 'tree');
    let pushed = false;
    try {
      git(root, ['worktree', 'add', '-q', '-b', head, tree, ref]);
      for (const f of plan.files) {
        const path = join(tree, f.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, f.content);
        if (f.mode) chmodSync(path, f.mode);
      }
      git(tree, ['add', '-A']);
      git(tree, ['commit', '-q', '-m', `tug ${VERSION}: shared agent delivery flow`]);
      log(`pushing ${head} (the pre-push gate runs)`);
      git(tree, ['push', '-q', '-u', 'origin', head], { stdio: ['ignore', 'inherit', 'inherit'] });
      pushed = true;
      const url = client.createPr({ base: branch, head, title: `tug ${VERSION}: shared agent delivery flow`, body: prBody(plan), labels: ['needs-owner'] });
      log(`opened ${url}`);
    } finally {
      if (pushed) {
        tryGit(root, ['worktree', 'remove', tree]);
        rmSync(scratch, { recursive: true, force: true });
      } else log(`left the work in ${tree} (branch ${head}) to inspect`);
    }
  }
  if (plan.defaultBranch) {
    client.setDefaultBranch(plan.defaultBranch.to);
    log(`default branch: ${plan.defaultBranch.from} -> ${plan.defaultBranch.to}`);
  }
  if (!plan.files.length && !plan.labels.length && !plan.defaultBranch) log('already up to date');
  return 0;
}
