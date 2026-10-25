#!/usr/bin/env node
// One fix at a time, each on its own branch and PR into a batch. Workers keep one worktree and reuse it.
//   fix.mjs start <name> [--batch <batch>]   branch fix/<name> from the batch (default: today's), in an idle worker worktree
//   fix.mjs start <name> --repair [--batch <batch>]
//                                            a fix for a batch whose PR is already open (its CI is red): it lands on that batch
//   fix.mjs done [--title ".."] [--body ".."] [--focus ".."]
//                                            in the fix worktree: full check, agent review, then the fix PR into the batch
//                                            (review posted on it, light CI if the repo has any), squash-merged when it passes
//   fix.mjs adopt <name>                     make the branch you are on (e.g. a T3 thread's) a fix for today's batch
//   fix.mjs eject <PR number | fix name> [--reason ".."]
//                                            revert that fix out of its batch (when the batch CI pins a failure on it)
// Without a GitHub remote, fixes are squash-merged into the batch locally instead of through PRs.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { sh, trySh, lines, q, slugify, wtRoot, gitPath, readJson, writeJson, onGitHub, install, batchCheckout, unfilteredPrWorkflows, sessionId } from './lib.mjs';
import { listBatches, nextBatch, whyNotJoinable } from './triage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MARKER = 'batchship-fix.json';
const marker = (wt) => readJson(gitPath(wt, MARKER));
const setMarker = (wt, m) => writeJson(gitPath(wt, MARKER), m);
const node = (script, args, cwd) => spawnSync(process.execPath, [join(here, script), ...args], { cwd, stdio: 'inherit' }).status;
export const isIdle = (wt) => !trySh('git status --porcelain', wt) && marker(wt)?.state !== 'working';

function pickBatch(cwd, wanted, { config, today, repair, session = sessionId(), name }) {
  const batches = listBatches(cwd, { live: config.protectedBranch, soloPaths: config.soloPaths });
  if (repair) {
    // A repair goes onto a batch that is shipping: its PR is open, so new fixes go elsewhere but this one belongs there.
    const shipping = batches.filter((x) => x.state === 'closing' || x.state === 'frozen');
    const b = wanted ? shipping.find((x) => x.name === wanted || x.name === `ship/${wanted}`) : shipping.length === 1 ? shipping[0] : null;
    if (!b) throw new Error(wanted ? `${wanted} has no open batch PR to repair` : `say which batch to repair (--batch): ${shipping.map((x) => x.name).join(', ') || 'none is shipping'}`);
    return b.name;
  }
  if (!wanted) return nextBatch(cwd, { batches, today, config, session, name }).batch;
  const b = batches.find((x) => x.name === wanted || x.name === `ship/${wanted}`);
  if (!b) throw new Error(`no batch ${wanted}; see triage.mjs list`);
  const why = whyNotJoinable(b, today, config);
  if (why) throw new Error(`cannot add to ${b.name}: ${why}`);
  return b.name;
}

function freeBranch(cwd, slug) {
  const taken = (b) => trySh(`git rev-parse --verify -q refs/heads/${b}`, cwd) || trySh(`git ls-remote --heads origin ${b}`, cwd);
  let b = `fix/${slug}`;
  for (let i = 2; taken(b); i++) b = `fix/${slug}-${i}`;
  return b;
}

export function start(cwd, name, { batch: wanted, repair = false, config, today = new Date(), install: doInstall = true }) {
  const slug = slugify(name);
  if (!slug) throw new Error('name the fix, e.g. fix.mjs start offline-qr-pass');
  const session = sessionId();
  const batch = pickBatch(cwd, wanted, { config, today, repair, session, name: slug });
  const root = wtRoot(cwd);
  const workers = existsSync(root) ? readdirSync(root).filter((d) => /^worker-\d+$/.test(d)).map((d) => join(root, d)) : [];
  const cur = trySh('git rev-parse --show-toplevel', cwd);
  let wt = workers.includes(cur) && isIdle(cur) ? cur : workers.find(isIdle);
  let fresh = false;
  if (!wt) {
    for (let i = 1; ; i++) { wt = join(root, `worker-${i}`); if (!existsSync(wt)) break; }
    sh(`git fetch -q origin ${batch}`, cwd);
    sh(`git worktree add -q --detach ${q(wt)} origin/${batch}`, cwd);
    fresh = true;
  }
  const before = trySh('git rev-parse HEAD', wt);
  sh(`git fetch -q origin ${batch}`, wt);
  const branch = freeBranch(wt, slug);
  sh(`git switch -q --no-track -c ${branch} origin/${batch}`, wt);
  setMarker(wt, { name, slug, branch, batch, repair, session, state: 'working', started: new Date().toISOString() });
  // A reused worktree only reinstalls when the dependency files changed.
  const depsChanged = fresh || !!trySh(`git diff --name-only ${before} HEAD -- '*package.json' '*lock*' 'pyproject.toml'`, wt);
  return { batch, branch, repair, worktree: wt, reused: !fresh, install: doInstall && depsChanged ? install(wt, config) : null };
}

export function adopt(cwd, name, { config, today = new Date() }) {
  const wt = sh('git rev-parse --show-toplevel', cwd);
  const branch = sh('git branch --show-current', wt);
  const special = [config.protectedBranch, ...(config.manualBranches || [])].includes(branch) || [...config.batchPrefixes, ...config.hotfixPrefixes].some((p) => branch.startsWith(p));
  if (!branch || special) throw new Error(`you are on ${branch || 'a detached HEAD'}; start a fix with fix.mjs start <name> instead`);
  const session = sessionId();
  const batch = pickBatch(cwd, null, { config, today, session, name: name || branch });
  setMarker(wt, { session, name: name || branch, slug: slugify(name || branch), branch, batch, state: 'working', started: new Date().toISOString() });
  return { batch, branch, worktree: wt };
}

const reviewComment = (m) => {
  const r = m?.results || [];
  if (!r.length) return '';
  return [`**Agent review** (${r.map((x) => x.name).join(', ')}): ${m.pass ? 'passed' : 'changes requested'}`, '',
    ...r.flatMap((x) => [`- **${x.name}**: ${x.ok ? `${x.verdict}. ${x.summary}` : `did not run: ${x.error}`}`,
      ...(x.findings || []).map((f) => `  - [${f.severity}] \`${f.file}${f.line ? `:${f.line}` : ''}\` ${f.summary}`)])].join('\n');
};

function waitForChecks(pr, cwd) {
  // Checks take a few seconds to register; a repo with no PR checks on ship/* has nothing to wait for.
  for (let i = 0; i < 6; i++) {
    const listed = trySh(`gh pr checks ${pr} --json name -q length`, cwd);
    if (+listed > 0) return spawnSync('gh', ['pr', 'checks', String(pr), '--watch', '--interval', '20'], { cwd, stdio: 'inherit' }).status === 0;
    spawnSync('sleep', ['5']);
  }
  return true;
}

export function done(cwd, { title, body, focus, config }) {
  const wt = sh('git rev-parse --show-toplevel', cwd);
  const m = marker(wt);
  if (m?.state !== 'working') throw new Error('no fix in progress here: run fix.mjs start <name> (or fix.mjs adopt <name>) first');
  if (trySh('git status --porcelain', wt)) throw new Error('commit your changes first');
  const live = config.protectedBranch;
  // A batch that started shipping meanwhile takes no more fixes: move to today's batch. A repair stays on its batch until it merges.
  const batches = listBatches(wt, { live, soloPaths: config.soloPaths });
  const b = batches.find((x) => x.name === m.batch);
  const staysPut = m.repair && b && b.state !== 'done';
  if (!staysPut && (!b || whyNotJoinable(b, new Date(), config))) {
    // The fix follows the session that started it (batchPer "session"), not whichever worker finishes it.
    const next = nextBatch(wt, { batches, today: new Date(), config, session: m.session, name: m.slug }).batch;
    console.log(`${m.batch} is not taking fixes (${b ? whyNotJoinable(b, new Date(), config) : 'gone'}): moving this fix to ${next}`);
    m.batch = next; setMarker(wt, m);
  }
  sh(`git fetch -q origin ${m.batch}`, wt);
  if (!+sh(`git rev-list --count origin/${m.batch}..HEAD`, wt)) throw new Error('no commits on this fix yet');
  if (trySh(`git merge-base --is-ancestor origin/${m.batch} HEAD && echo y`, wt) !== 'y') {
    try { sh(`git merge -q --no-edit origin/${m.batch}`, wt); }
    catch { throw new Error(`merging the latest ${m.batch} conflicts: resolve the conflicts here, commit, then run fix.mjs done again`); }
  }
  console.log(`== check (shipOnly checks wait for the batch)`);
  if (node('batch-check.mjs', ['--fix'], wt) !== 0) throw Object.assign(new Error('batch-check failed: fix it, commit, run fix.mjs done again'), { code: 1 });
  console.log(`\n== agent review`);
  const rv = node('review.mjs', ['--base', `origin/${m.batch}`, ...(focus ? ['--focus', focus] : [])], wt);
  if (rv !== 0) throw Object.assign(new Error(rv === 1 ? 'review asked for changes: fix them, commit, run fix.mjs done again' : 'review could not run'), { code: rv });
  const subjects = lines(sh(`git log --first-parent --no-merges --format=%s origin/${m.batch}..HEAD`, wt)).reverse();
  const t = title || (subjects.length === 1 ? subjects[0] : m.name);
  const bodyText = body || (subjects.length > 1 ? subjects.map((s) => `- ${s}`).join('\n') : '');
  let pr = null;
  if (onGitHub(wt)) {
    const costly = unfilteredPrWorkflows(wt);
    if (costly.length) console.log(`note: ${costly.join(', ')} run on every PR (no branches filter), so fix PRs into ship/* cost CI there. Limit pull_request to branches: [${live}].`);
    sh(`git push -q -u origin ${m.branch}`, wt);
    pr = +trySh(`gh pr list --head ${m.branch} --state open --json number -q '.[0].number'`, wt) || null;
    if (!pr) {
      const url = sh(`gh pr create --base ${m.batch} --head ${m.branch} --title ${q(t)} --body ${q(bodyText || t)}`, wt);
      pr = +url.match(/\/pull\/(\d+)/)[1];
    }
    const note = reviewComment(readJson(gitPath(wt, 'batchship-review.json')));
    if (note) { const f = gitPath(wt, 'batchship-review.md'); writeFileSync(f, note); trySh(`gh pr comment ${pr} --body-file ${q(f)}`, wt); }
    if (!waitForChecks(pr, wt)) throw Object.assign(new Error(`checks failed on fix PR #${pr}: fix, commit, run fix.mjs done again`), { code: 1 });
    try { sh(`gh pr merge ${pr} --squash --subject ${q(`${t} (#${pr})`)} --body ${q(bodyText)}`, wt); }
    catch (e) { throw Object.assign(new Error(`could not merge fix PR #${pr} into ${m.batch} (${e.stderr?.toString().trim() || e.message}). It stays open; deal with what blocks it, then run fix.mjs done again.`), { code: 1 }); }
    trySh(`git push -q origin --delete ${m.branch}`, wt);
  } else {
    const bw = batchCheckout(wt, m.batch);
    sh(`git merge -q --squash ${m.branch}`, bw);
    sh(`git commit -q -m ${q(t)}${bodyText ? ` -m ${q(bodyText)}` : ''}`, bw);
    sh(`git push -q origin ${m.batch}`, bw);
  }
  sh(`git fetch -q origin ${m.batch}`, wt);
  const commit = sh(`git rev-parse --short origin/${m.batch}`, wt);
  sh(`git switch -q --detach origin/${m.batch}`, wt);
  trySh(`git branch -D ${m.branch}`, wt);
  setMarker(wt, { ...m, state: 'merged', pr, commit, merged: new Date().toISOString() });
  return { batch: m.batch, pr, commit, title: t };
}

export function eject(cwd, ref, { reason = '', config }) {
  const live = config.protectedBranch;
  const batches = listBatches(cwd, { live, soloPaths: config.soloPaths }).filter((b) => b.state !== 'done');
  const match = (s) => (/^\d+$/.test(ref) ? s.endsWith(`(#${ref})`) : s.toLowerCase().includes(String(ref).toLowerCase()));
  for (const b of batches) {
    const hit = lines(trySh(`git log --first-parent --no-merges --format='%H %s' origin/${live}..origin/${b.name}`, cwd)).map((l) => [l.slice(0, 40), l.slice(41)]).find(([, s]) => match(s));
    if (!hit) continue;
    const bw = batchCheckout(cwd, b.name);
    sh(`git revert --no-edit ${hit[0]}`, bw);
    if (reason) sh(`git commit -q --amend -m ${q(`Eject: ${hit[1]}`)} -m ${q(reason)}`, bw);
    sh(`git push -q origin ${b.name}`, bw);
    if (/^\d+$/.test(ref)) trySh(`gh pr comment ${ref} --body ${q(`Ejected from ${b.name}${reason ? `: ${reason}` : ''}. Redo it as a new fix (fix.mjs start).`)}`, cwd);
    return { batch: b.name, reverted: hit[1], commit: sh('git rev-parse --short HEAD', bw) };
  }
  throw new Error(`no fix matching ${ref} in an open batch`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const opts = { repair: args.includes('--repair'), batch: flag('batch'), title: flag('title'), body: flag('body'), focus: flag('focus'), reason: flag('reason'), install: !args.includes('--no-install') };
  const [cmd, name] = args.filter((a) => !a.startsWith('--'));
  try {
    const top = sh('git rev-parse --show-toplevel');
    const config = loadConfig(top);
    if (cmd === 'start') {
      const r = start(top, name, { ...opts, config });
      console.log([`FIX ${r.branch} -> ${r.batch}${r.reused ? ' (reused worker)' : ''}`, `work in: ${r.worktree}`,
        r.install && `${r.install.ok ? 'installed' : 'INSTALL FAILED, run it by hand'}: ${r.install.cmd}`,
        r.repair && 'A repair: when it merges, the batch PR runs CI again (ship.mjs --merge waits for it).',
        'Commit there (quick check: batch-check.mjs --quick), then run fix.mjs done.'].filter(Boolean).join('\n'));
    } else if (cmd === 'adopt') {
      const r = adopt(top, name, { config });
      console.log(`FIX ${r.branch} -> ${r.batch} (adopted). Run fix.mjs done when it is ready.`);
    } else if (cmd === 'done') {
      const r = done(top, { ...opts, config });
      console.log(`\nMERGED into ${r.batch}${r.pr ? ` via PR #${r.pr}` : ''} as ${r.commit}: ${r.title}\nThis worktree is idle again: fix.mjs start <name> for the next fix.`);
    } else if (cmd === 'eject') {
      const r = eject(top, name, { ...opts, config });
      console.log(`EJECTED "${r.reverted}" from ${r.batch} (revert ${r.commit}).`);
    } else throw new Error('use: fix.mjs start <name> | done | adopt <name> | eject <PR|name>');
  } catch (e) {
    console.error(`fix: ${e.stderr?.toString().trim() || e.message}`);
    process.exit(e.code || 1);
  }
}
