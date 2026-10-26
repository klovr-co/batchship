#!/usr/bin/env node
// Ship a batch: one PR to the live branch, one CI run.
//   ship.mjs [<batch>] [--merge]
// Merges the live branch into the batch, runs the full check and an advisory review of the whole batch, pushes, and opens
// (or updates) the batch PR as a draft listing every fix. Open fix PRs still aimed at the batch move to today's batch.
// Then: review.after "merge" (default, from the live branch's .ship.json) when the user asked to ship in this session (or a human
// runs it), or --merge, marks it ready, waits for CI and merges with a merge commit. It stops at the draft when the whole-batch review finds a
// blocker or major issue. review.after "human" stops for the human to mark it ready and merge.
// With the Mergify queue (mergeVia, default: when the repo has .mergify.yml) ship.mjs queues the PR instead of merging it:
// Mergify brings it up to date with the live branch, waits for CI and merges it. Out of the queue counts as red CI.
// A blocker from the whole-batch review goes to a repair fix review.batchRepairRounds times before the PR waits for the human.
// Waiting for CI takes as long as the CI run: start it in the background.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig, withLivePolicy } from './config.mjs';
import { sh, trySh, lines, q, gitPath, readJson, writeJson, onGitHub, batchCheckout, unlocked, usesMergify, queueOutcome, ESCALATE, sessionId } from './lib.mjs';
import { listBatches, nextBatch, sessionBatchName, sessionOwner, rememberSession, DAY_SLUG } from './triage.mjs';
import { sameHarness } from './review.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const node = (script, args, cwd) => spawnSync(process.execPath, [join(here, script), ...args], { cwd, stdio: 'inherit' }).status;

// The batch PR text: what is in it, why it exists, what the advisory review said, how to merge it.
export function prText({ batch, live, subjects, reason, review = [], mergify = false }) {
  const fixes = subjects.filter((s) => !s.startsWith('batch: '));
  const short = (s) => s.replace(/\s*\(#\d+\)$/, '');
  const m = batch.match(/^ship\/(.+?)-(\d{4})(\d\d)(\d\d)/);
  const label = m ? (m[1] === DAY_SLUG ? `${m[2]}-${m[3]}-${m[4]}` : `${m[1]} ${m[2]}-${m[3]}-${m[4]}`) : batch;
  let title = `Batch ${label}: ${fixes.slice(0, 3).map(short).join(', ')}`;
  if (fixes.length > 3) title += ` (+${fixes.length - 3})`;
  if (title.length > 120) title = `${title.slice(0, 110)}… (${fixes.length} fixes)`;
  const findings = review.flatMap((r) => [`- **${r.name}**: ${r.ok ? `${r.verdict}. ${r.summary}` : `did not run: ${r.error}`}`,
    ...(r.findings || []).map((f) => `  - [${f.severity}] \`${f.file}${f.line ? `:${f.line}` : ''}\` ${f.summary}`)]);
  const body = [
    `${fixes.length} fix${fixes.length === 1 ? '' : 'es'}, one CI run. Each fix was reviewed on its own PR before it joined this batch.`,
    '', '## Fixes', ...fixes.map((s) => { const n = s.match(/\(#(\d+)\)$/); return n ? `- #${n[1]} ${short(s)}` : `- ${s}`; }),
    ...(reason ? ['', '## Why a separate batch', reason] : []),
    ...(findings.length ? ['', '## Advisory review of the whole batch', 'How the fixes interact and the merge resolutions. It does not block.', ...findings] : []),
    '', '## Merging',
    ...(mergify ? ['The Mergify merge queue merges this PR: it brings it up to date with the live branch, waits for CI, then merges.'] : []),
    `Merge with a **merge commit**, not squash: each fix stays its own commit on \`${live}\`, so one fix can be reverted alone and \`git blame\` leads to its PR.`,
    'If CI is red: a runner or flaky failure, re-run only the failed jobs. A real failure, find the fix with `git bisect run <failing test>` over this batch, then fix forward (`fix.mjs start <name> --repair`, `fix.mjs done`) or `fix.mjs eject <PR>`, and run `ship.mjs` again.',
  ].join('\n');
  return { title, body };
}

// Whether ship.mjs merges the batch PR itself. An agent merges only when the user asked to ship in its session: otherwise an
// agent shipping after one fix would put a half-done list on the live branch. A human at a terminal follows review.after.
export function autoMerge({ merge, after, agent, asked }) {
  return merge || (after === 'merge' && (!agent || asked));
}

// The first changed file under review.humanPaths: such a batch always waits for the human to mark it ready.
export const humanGate = (files = [], humanPaths = []) => files.find((f) => humanPaths.some((p) => f.startsWith(p))) || null;

export function ship(cwd, wanted, { merge = false }) {
  const config = withLivePolicy(cwd, loadConfig(cwd));
  const live = config.protectedBranch;
  // The session that runs this must be the one where the user asked (Claude Code sets CLAUDE_CODE_SESSION_ID); a human at a terminal uses BATCHSHIP_ALLOW=1.
  const session = sessionId();
  const human = process.env.BATCHSHIP_ALLOW === '1';
  const asked = (session && unlocked(cwd, session).has('ship')) || human;
  if (merge && !asked)
    throw new Error('--merge needs the user to ask for it in the session ("ship when done", "then ship", "ship now"). A human at a terminal can run BATCHSHIP_ALLOW=1 ship.mjs --merge.');
  const today = new Date();
  let batches = listBatches(cwd, { live, soloPaths: config.soloPaths });
  const withFixes = batches.filter((b) => b.state !== 'done' && b.commits.length);
  // batchPer "session": an agent ships its own session's batch, never another thread's.
  const perSession = config.batchPer === 'session' && session;
  const own = perSession ? sessionBatchName(cwd, session) : null;
  // Without a batch of its own a session names the batch to ship: a bare ship.mjs never picks up another thread's work.
  if (perSession && !own && !wanted) {
    const names = withFixes.map((x) => x.name);
    throw new Error(`this session has no batch of its own (batchPer "session"): name the batch to ship${names.length ? ` (${names.join(', ')})` : ''}`);
  }
  const b = wanted ? batches.find((x) => x.name === wanted || x.name === `ship/${wanted}`)
    : own ? batches.find((x) => x.name === own)
    : withFixes.find((x) => x.slug === DAY_SLUG && x.state === 'open') || (withFixes.length === 1 ? withFixes[0] : null);
  if (!b) throw new Error(wanted ? `no batch ${wanted}` : own ? `this session's batch ${own} is gone` : `say which batch to ship: ${withFixes.map((x) => x.name).join(', ') || 'none has fixes yet'}`);
  if (b.state === 'done') throw new Error(`${b.name} is already merged or closed`);
  if (!b.commits.length) throw new Error(`${b.name} has no fixes yet`);
  if (perSession && b.name !== own) {
    // A batch no thread owns (made before batchPer "session", or by a human) is adopted only when named explicitly, by a
    // session that has none yet. Any other batch belongs to another thread: this session may open its draft PR, but not merge it.
    const owner = sessionOwner(cwd, b.name);
    if (!own && !owner && wanted) rememberSession(cwd, session, b.name);
    else if (merge && !human)
      throw new Error(`${b.name} is ${owner ? 'another thread\'s batch' : 'not this session\'s batch'} (batchPer "session"${own ? `; this session's is ${own}` : ''}): ship it without --merge for a draft, and let its own thread or the human merge it`);
  }
  const bw = batchCheckout(cwd, b.name);
  sh(`git fetch -q origin ${live} ${b.name}`, bw);
  try { sh(`git merge -q --no-edit origin/${live}`, bw); }
  catch { trySh('git merge --abort', bw); throw new Error(`merging ${live} into ${b.name} conflicts: resolve it with a fix PR (or in ${bw}), then ship again`); }
  console.log('== full check');
  if (node('batch-check.mjs', [], bw) !== 0) throw Object.assign(new Error('batch-check failed on the batch: fix forward with a fix PR, then ship again'), { code: 1 });
  const out = gitPath(bw, 'batchship-batch-review.json');
  writeFileSync(out, '[]');
  console.log('\n== advisory review of the whole batch');
  node('review.mjs', ['--advisory', '--base', `origin/${live}`, '--out', out], bw);
  sh(`git push -q origin ${b.name}`, bw);
  const subjects = lines(sh(`git log --first-parent --no-merges --reverse --format=%s origin/${live}..HEAD`, bw));
  const reason = (subjects.find((s) => s.startsWith('batch: ')) || '').slice(7);
  const mergify = usesMergify(bw, config);
  const { title, body } = prText({ batch: b.name, live, subjects, reason, review: readJson(out) || [], mergify });
  if (!onGitHub(bw)) return { batch: b.name, local: true, title };
  const bodyFile = gitPath(bw, 'batchship-batch-pr.md');
  writeFileSync(bodyFile, body);
  let pr = b.pr?.number;
  if (pr && b.state !== 'done') sh(`gh pr edit ${pr} --title ${q(title)} --body-file ${q(bodyFile)}`, bw);
  else pr = +sh(`gh pr create --draft --base ${live} --head ${b.name} --title ${q(title)} --body-file ${q(bodyFile)}`, bw).match(/\/pull\/(\d+)/)[1];
  // The batch now has a PR, so it takes no more fixes: open fix PRs move to today's batch.
  batches = listBatches(cwd, { live, soloPaths: config.soloPaths });
  const moved = [];
  const open = (batches.find((x) => x.name === b.name)?.fixes || []).filter((f) => f.state === 'open');
  if (open.length) {
    const next = nextBatch(cwd, { batches, today, config, session, name: 'thread' }).batch;
    for (const f of open) try { sh(`gh pr edit ${f.number} --base ${next}`, cwd); moved.push(`#${f.number} -> ${next}`); } catch {}
  }
  if (!autoMerge({ merge, after: config.review.after, agent: sameHarness(), asked })) return { batch: b.name, pr, title, moved, merged: false };
  const gate = humanGate(lines(sh(`git diff --name-only origin/${live}...HEAD`, bw)), config.review.humanPaths);
  if (gate) return { batch: b.name, pr, title, moved, merged: false, human: gate };
  // Each fix passed its own review; the whole-batch review only stops the merge when the fixes break each other.
  const held = (readJson(out) || []).filter((r) => r.ok).flatMap((r) => r.findings || []).filter((f) => f.severity === 'blocker' || f.severity === 'major');
  // Red CI gets review.ciRounds tries (re-run, repair or eject, then ship again), counted per batch; then it is the human's.
  const ciFile = gitPath(bw, 'batchship-ci.json');
  const ci = readJson(ciFile) || {};
  const red = ci[b.name]?.red || 0;
  if (held.length) {
    // A blocker gets review.batchRepairRounds repair fixes (each reviewed like any fix); then the draft waits for the human.
    const repairs = ci[b.name]?.held || 0;
    if (repairs >= config.review.batchRepairRounds) return { batch: b.name, pr, title, moved, merged: false, held: held.length };
    writeJson(ciFile, { ...ci, [b.name]: { ...ci[b.name], held: repairs + 1, at: new Date().toISOString() } });
    throw Object.assign(new Error([`The whole-batch review found ${held.length} blocker/major issue(s) on #${pr} (listed on the PR); it stays a draft.`,
      `Repair it (${repairs + 1} of ${config.review.batchRepairRounds}): fix.mjs start <name> --repair --batch ${b.name}, fix the findings, fix.mjs done, then run ship.mjs again.`,
      ESCALATE].join('\n')), { code: 1 });
  }
  if (red >= config.review.ciRounds && process.env.BATCHSHIP_ALLOW !== '1')
    throw Object.assign(new Error(`CI was red ${red} times on #${pr} (review.ciRounds is ${config.review.ciRounds}): stop and hand it to the human with what failed.`), { code: 1 });
  trySh(`gh pr ready ${pr}`, bw);
  const red_ = (failed, extra) => {
    writeJson(ciFile, { ...ci, [b.name]: { ...ci[b.name], red: red + 1, at: new Date().toISOString() } });
    const left = config.review.ciRounds - red - 1;
    return Object.assign(new Error([`CI is red on #${pr} (try ${red + 1} of ${config.review.ciRounds}). Nothing was merged.`,
      extra, failed.length && `Failed: ${failed.join(', ')}`,
      left > 0 ? `Next: a runner or flaky failure, re-run the failed jobs (gh run rerun <run> --failed); a real one, find the fix with git bisect run <test>, then repair it (fix.mjs start <name> --repair, fix.mjs done) or eject it (fix.mjs eject <PR>). Then run ship.mjs again. ${ESCALATE}`
        : 'No tries left: hand it to the human with what failed.'].filter(Boolean).join('\n')), { code: 1 });
  };
  if (mergify) {
    // Queue it; Mergify updates the batch with the live branch when needed (a merge commit, never a rewrite), waits for CI, merges.
    const since = Date.now() - 5000;
    sh(`gh pr comment ${pr} --body '@mergifyio queue'`, bw);
    console.log(`\n== queued #${pr} with Mergify; waiting for it to merge`);
    const deadline = Date.now() + (config.review.queueTimeoutMinutes || 120) * 60000;
    let last = '';
    for (;;) {
      spawnSync('sleep', ['30']);
      let view;
      try { view = JSON.parse(sh(`gh pr view ${pr} --json state,comments`, bw)); } catch { continue; }
      const r = queueOutcome(view, since);
      if (r.done === 'merged') return { batch: b.name, pr, title, moved, merged: true, via: 'mergify' };
      if (r.done === 'closed') throw Object.assign(new Error(`#${pr} was closed while queued.`), { code: 1 });
      if (r.done === 'dequeued') {
        const failed = r.checks.length ? r.checks : lines(trySh(`gh pr checks ${pr} --json name,bucket -q '.[] | select(.bucket == "fail") | .name'`, bw) || '');
        throw red_(failed, `Mergify took it out of the queue: ${r.reason}.`);
      }
      if (r.state !== last) { console.log(`   queue: ${r.state}`); last = r.state; }
      if (Date.now() > deadline) throw Object.assign(new Error(`#${pr} is still in the Mergify queue (${r.state}) after ${config.review.queueTimeoutMinutes || 120} min: check the Mergify dashboard, then hand it to the human.`), { code: 1 });
    }
  }
  console.log(`\n== waiting for CI on #${pr}`);
  spawnSync('sleep', ['15']);
  const green = spawnSync('gh', ['pr', 'checks', String(pr), '--watch', '--interval', '30'], { cwd: bw, stdio: 'inherit' }).status === 0;
  if (!green) throw red_(lines(trySh(`gh pr checks ${pr} --json name,bucket -q '.[] | select(.bucket == "fail") | .name'`, bw) || ''));
  sh(`gh pr merge ${pr} --merge`, bw);
  return { batch: b.name, pr, title, moved, merged: true };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const [wanted] = args.filter((a) => !a.startsWith('--'));
  try {
    const r = ship(sh('git rev-parse --show-toplevel'), wanted, { merge: args.includes('--merge') });
    if (r.local) console.log(`\nSHIPPED ${r.batch} locally (no GitHub remote): merge it into the live branch with a merge commit.`);
    else console.log([`\nBATCH PR #${r.pr}: ${r.title}`, r.moved.length && `moved open fix PRs: ${r.moved.join(', ')}`,
      r.merged ? (r.via === 'mergify' ? 'Merged by the Mergify queue after a green CI run.' : 'CI green: merged with a merge commit.')
        : r.human ? `Left as a draft for the human: it touches ${r.human} (review.humanPaths). They mark it ready; with Mergify they also queue it (tick the box in Mergify's comment).`
        : r.held ? `Left as a draft: the whole-batch review found ${r.held} blocker/major issue(s), listed on the PR. Fix forward with a fix PR, or the human marks it ready and merges.`
        : 'Draft: the human marks it ready (one CI run) and merges it with a merge commit.'].filter(Boolean).join('\n'));
  } catch (e) {
    console.error(`ship: ${e.stderr?.toString().trim() || e.message}`);
    process.exit(e.code || 1);
  }
}
