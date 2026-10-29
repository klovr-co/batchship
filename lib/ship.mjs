// tug ship <pr> [--now]: queue a PR with Mergify and stay with it until it is merged and deployed.
// What it knows about Mergify (learned on 3ven and aldrent, 29 Oct 2026):
//   - the `queue` label alone does not queue a PR here: a comment that is exactly `@mergifyio queue` does;
//   - any push to a queued PR cancels its place, and a command posted right after a push is cancelled too
//     ("new commits were pushed"), so re-post only once Mergify has registered the push: its check on the old
//     head says "Dequeued — pull request manually updated", or its check on the new head has settled;
//   - CI runs on Mergify's batch draft, not on the PR, so the PR's own checks say nothing: read the Mergify check.
import { shipBranch } from './config.mjs';

export const EXIT = Object.freeze({ ok: 0, error: 1, refused: 2, dequeued: 3, deployFailed: 4, timeout: 5 });
export const QUEUE_COMMAND = '@mergifyio queue';
const BLOCKING = ['needs-owner', 'hold'];

/** The Mergify Merge Queue check run's state, from its title (and, for in-queue states, its summary). */
export function classify(check) {
  if (!check) return 'none';
  const title = check.title || '';
  if (/^Merged/i.test(title)) return 'merged';
  if (/^Dequeued/i.test(title) && /manually updated/i.test(title)) return 'dequeued-push';
  if (/^Dequeued/i.test(title) && /merged manually/i.test(title)) return 'merged';
  if (/^Dequeued/i.test(title)) return 'dequeued';
  if (/under evaluation/i.test(title)) return 'pending';
  if (/queue is ready/i.test(title)) return 'ready';
  if (/^Waiting for queue conditions/i.test(title)) return 'waiting';
  if (/Running merge queue checks|embarked|queued|in the queue|Waiting for (CI|checks|batch|merge)/i.test(title)) return 'queued';
  if (check.status !== 'completed' || /Entered the queue/i.test(check.summary || '')) return 'queued';
  return 'unknown';
}

/** What Mergify is waiting for, from its summary ("Waiting for" list), or ''. */
export function waitingFor(check) {
  const summary = check?.summary || '';
  const at = summary.search(/\*\*Waiting for\*\*/);
  const part = at >= 0 ? summary.slice(at) : summary;
  const items = [...part.matchAll(/^\s*-\s*⏳\s*`([^`]+)`/gm)].map(m => m[1]);
  return [...new Set(items)].join(', ');
}

/** Why Mergify dequeued a PR, from its summary's "Reason" section or title. */
export function dequeueReason(check) {
  const summary = check?.summary || '';
  const reason = /\*\*Reason\*\*\s*\n+([^\n]+)/.exec(summary)?.[1]?.trim();
  return reason || check?.title || 'no reason given';
}

const short = sha => String(sha || '').slice(0, 7);
const READS = ['pr', 'mergifyCheck', 'runs', 'branchRuns', 'contains', 'openPrsWithLabel'];

/** The client with its read calls retried (a GitHub blip must not end a wait that can last hours). Writes are not retried. */
export function retrying(client, { sleep, log, pollMs, tries = 5 }) {
  const out = { ...client };
  for (const name of READS) {
    if (typeof client[name] !== 'function') continue;
    out[name] = async (...args) => {
      for (let i = 1; ; i++) {
        try {
          return await client[name](...args);
        } catch (err) {
          if (i >= tries) throw err;
          log(`gh ${name} failed (${String(err.message || err).split('\n')[0]}); retrying (${i}/${tries - 1})`);
          await sleep(Math.min(pollMs * i, 120_000));
        }
      }
    };
  }
  return out;
}
const SKEW_MS = 30_000;
const checkTime = check => Date.parse(check?.completedAt || check?.startedAt || '') || 0;

/**
 * Run the state machine. Returns { code, line, next } (next: the one next step, on failure).
 * client: see lib/gh.mjs createClient. sleep(ms) and clock() are injectable; log(text) prints progress.
 */
export async function ship({
  client,
  number,
  now = false,
  config,
  log = () => {},
  sleep = ms => new Promise(r => setTimeout(r, ms)),
  clock = Date.now,
  pollMs = 20_000,
  graceMs = 3 * 60_000, // how long a just-posted command may sit unanswered before posting it again
  waitingMs = 10 * 60_000, // how long Mergify may wait for queue conditions before we report it
  timeoutMs = 4 * 60 * 60_000, // the whole queue wait
  deployStartMs = 10 * 60_000, // how long a deploy run may take to appear
  deployTimeoutMs = 60 * 60_000,
  maxPosts = 8,
}) {
  try {
    return await run({ client: retrying(client, { sleep, log, pollMs }), number, now, config, log, sleep, clock, pollMs, graceMs, waitingMs, timeoutMs, deployStartMs, deployTimeoutMs, maxPosts });
  } catch (err) {
    return {
      code: EXIT.error,
      line: `tug ship #${number}: stopped: ${String(err.message || err).split('\n')[0]}`,
      next: `check \`gh auth status\` and githubstatus.com, then run tug ship ${number} again (the PR may still be queued; running again is safe)`,
    };
  }
}

async function run({ client, number, now, config, log, sleep, clock, pollMs, graceMs, waitingMs, timeoutMs, deployStartMs, deployTimeoutMs, maxPosts }) {
  const base = shipBranch(config);
  const tag = `tug ship #${number}`;
  const result = (code, what, next) => ({ code, line: `${tag}: ${what}`, ...(next ? { next } : {}) });
  const blockedBy = p => BLOCKING.filter(l => p.labels.includes(l));
  const blockedNext = labels =>
    labels.includes('needs-owner')
      ? 'ask the user the "Needs owner:" question; when they say yes, remove needs-owner (`gh pr edit <n> --remove-label needs-owner`) and run tug ship again'
      : 'hold means the user said not now: leave it until they say ship it, then remove hold and run tug ship again';

  let p = await client.pr(number);
  if (p.state === 'CLOSED') return result(EXIT.refused, 'closed without merging', 'reopen it or open a new PR, then run tug ship again');

  if (p.state !== 'MERGED') {
    const blocked = blockedBy(p);
    if (blocked.length) return result(EXIT.refused, `not shipped: it has the ${blocked.join(' and ')} label`, blockedNext(blocked));
    if (p.baseRefName !== base) return result(EXIT.refused, `targets ${p.baseRefName}, but shipTarget ${config.shipTarget} is ${base}`, `gh pr edit ${number} --base ${base}, then run tug ship again`);
    if (now) {
      const others = (await client.openPrsWithLabel('hotfix')).filter(n => n !== number);
      if (others.length) return result(EXIT.refused, `not hotfixed: #${others[0]} already has hotfix, and one hotfix runs at a time`, `run tug ship ${number} without --now (it joins the next batch), or wait for #${others[0]} to merge`);
    }
    if (p.isDraft) {
      await client.ready(number);
      log(`marked #${number} ready for review`);
    }
    const want = ['queue', ...(now ? ['hotfix'] : [])].filter(l => !p.labels.includes(l));
    if (want.length) {
      await client.addLabels(number, want);
      log(`labelled ${want.join(', ')}`);
    }

    const started = clock();
    let posts = 0;
    let postedFor = null; // the head sha the last command was posted for
    let postedAt = 0;
    let pushSeen = null; // { from, at }: a push we saw and have not queued again for
    let waitingSince = null;
    let silentPosts = 0; // posts that got no Mergify check at all
    let last = null;
    const post = async head => {
      if (posts >= maxPosts) throw Object.assign(new Error(`posted ${QUEUE_COMMAND} ${posts} times and Mergify has not queued it`), { code: EXIT.timeout });
      await client.comment(number, QUEUE_COMMAND);
      posts++;
      postedFor = head;
      postedAt = clock();
      log(`posted "${QUEUE_COMMAND}" for ${short(head)}`);
    };

    try {
      const first = classify(await client.mergifyCheck(p.headRefOid));
      if (first === 'queued' || first === 'merged') {
        postedFor = p.headRefOid;
        postedAt = clock();
        log(now && want.includes('hotfix') ? 'already in the queue; hotfix label added (whether Mergify moves a queued PR to the hotfix queue is not checked)' : 'already in the queue');
      } else await post(p.headRefOid);

      for (;;) {
        if (clock() - started > timeoutMs) {
          return result(EXIT.timeout, `still not merged after ${Math.round(timeoutMs / 60_000)} min (Mergify: ${last ?? 'no check'})`, `open the PR's "Mergify Merge Queue" check, then run tug ship ${number} again`);
        }
        await sleep(pollMs);
        p = await client.pr(number);
        if (p.state === 'MERGED') break;
        if (p.state === 'CLOSED') return result(EXIT.refused, 'was closed while queued', 'find out who closed it and why before opening it again');
        const blocked = blockedBy(p);
        if (blocked.length) return result(EXIT.refused, `left the queue: someone added ${blocked.join(' and ')}`, blockedNext(blocked));

        const head = p.headRefOid;
        if (head !== postedFor) {
          // A push. Mergify cancels a command posted before it has seen the push, so wait until it has.
          if (!pushSeen) {
            pushSeen = { from: postedFor, at: clock() };
            log(`push seen (${short(pushSeen.from)} -> ${short(head)}); waiting for Mergify to register it`);
          }
          const newCheck = await client.mergifyCheck(head);
          const newState = classify(newCheck);
          if (newState === 'queued') {
            log('queued again (by someone else)');
            postedFor = head;
            postedAt = clock();
            pushSeen = null;
            continue;
          }
          const oldState = classify(await client.mergifyCheck(pushSeen.from));
          const settled = newCheck && newCheck.status === 'completed' && ['ready', 'waiting', 'dequeued-push'].includes(newState);
          if (oldState === 'dequeued-push' || settled || clock() - pushSeen.at > 2 * graceMs) {
            log(oldState === 'dequeued-push' ? 'Mergify: Dequeued — pull request manually updated' : `Mergify registered the push (${newCheck?.title || 'no check after waiting'})`);
            pushSeen = null;
            waitingSince = null;
            await post(head);
          }
          continue;
        }

        const check = await client.mergifyCheck(head);
        let state = classify(check);
        // A check that settled well before our command is Mergify's answer to an earlier one, not to ours (the 30 s
        // allow for clock skew). Treat it as "no answer yet": after the grace period that means post again.
        if (['dequeued', 'dequeued-push', 'ready', 'waiting'].includes(state) && checkTime(check) && checkTime(check) < postedAt - SKEW_MS) {
          if (clock() - postedAt > graceMs) await post(head);
          continue;
        }
        const title = check?.title || 'no Mergify check yet';
        if (title !== last) {
          log(`Mergify: ${title}`);
          last = title;
        }
        if (state === 'none' || state === 'pending') {
          // No answer at all: the Mergify app is missing, its config is invalid, or it is slow. Try twice more, then say so.
          if (clock() - postedAt > graceMs) {
            if (silentPosts >= 2) {
              return result(EXIT.timeout, `Mergify is not answering (${check ? check.title : 'no "Mergify Merge Queue" check'} after ${posts} posts)`, `check that the Mergify app is installed on the repo and that .mergify.yml on the default branch is valid (its "Configuration changed" check), then run tug ship ${number} again`);
            }
            silentPosts++;
            await post(head);
          }
          continue;
        }
        silentPosts = 0;
        if (state === 'queued' || state === 'merged') {
          waitingSince = null;
          continue;
        }
        if (state === 'dequeued') {
          return result(EXIT.dequeued, `Mergify took it out of the queue: ${dequeueReason(check)}`, `read Mergify's comment on the PR, fix the failure, push, then run tug ship ${number} again`);
        }
        if (state === 'ready' || state === 'dequeued-push') {
          if (clock() - postedAt > graceMs) await post(head);
          continue;
        }
        if (state === 'waiting') {
          waitingSince ??= clock();
          if (clock() - waitingSince > waitingMs) {
            const what = waitingFor(check);
            const conflict = /conflict/.test(what);
            return result(
              EXIT.dequeued,
              `Mergify is not queueing it: waiting for ${what || 'its queue conditions'}`,
              conflict ? `merge origin/${base} into the branch, resolve the conflict, push, then run tug ship ${number} again` : `make the PR meet those conditions (see .mergify.yml), then run tug ship ${number} again`,
            );
          }
        }
      }
    } catch (err) {
      if (err.code === EXIT.timeout) return result(EXIT.timeout, err.message, `open the PR's "Mergify Merge Queue" check; if it says to, queue it from the Mergify dashboard`);
      throw err;
    }
  }

  const sha = p.mergeCommit?.oid;
  if (!sha) return result(EXIT.error, 'merged, but GitHub gave no merge commit', 'look at the PR on GitHub');
  log(`merged as ${short(sha)}`);
  const deploys = [];
  for (const workflow of config.deployWorkflows || []) {
    log(`waiting for ${workflow} on ${short(sha)}`);
    deploys.push({ workflow, ...(await waitForDeploy({ client, workflow, sha, base, sleep, clock, pollMs, deployStartMs, deployTimeoutMs })) });
  }
  const live = config.liveUrl ? ` · live: ${config.liveUrl}` : '';
  const summary = deploys.length ? deploys.map(d => `${d.workflow} ${d.status}`).join(', ') : 'none configured';
  const line = `merged ${short(sha)} into ${base} · deploy: ${summary}${live}`;
  const failed = deploys.find(d => d.status === 'failure' || d.status.startsWith('cancelled') || d.status.startsWith('skipped'));
  if (failed) return result(EXIT.deployFailed, line, `open ${failed.url}: the merge is in ${base}, so fix forward with a new PR (or revert ${short(sha)} in one) and ship it`);
  const slow = deploys.find(d => d.status === 'timed out');
  if (slow) return result(EXIT.timeout, line, `the deploy is still running: watch ${slow.url}, then check ${config.liveUrl || 'the live site'}`);
  return result(EXIT.ok, line);
}

/** Wait for one deploy workflow on the merge commit: { status: success|failure|not run|timed out, url }. */
async function waitForDeploy({ client, workflow, sha, base, sleep, clock, pollMs, deployStartMs, deployTimeoutMs }) {
  const started = clock();
  for (;;) {
    let runs = await client.runs(workflow, sha);
    let run = runs[0];
    // A later merge can supersede ours (concurrency cancels the older deploy): then the newer run deploys it too.
    if (!run || run.conclusion === 'cancelled' || run.conclusion === 'skipped') {
      const later = [];
      for (const r of (await client.branchRuns(workflow, base)).slice(0, 5)) if (r.headSha !== sha && (await client.contains(sha, r.headSha))) later.push(r);
      if (later.length) run = later.find(r => r.conclusion !== 'cancelled' && r.conclusion !== 'skipped') || run;
    }
    if (run?.status === 'completed') {
      if (run.conclusion === 'success') return { status: 'success', url: run.url };
      if (run.conclusion === 'cancelled' || run.conclusion === 'skipped') {
        if (clock() - started > deployStartMs) return { status: `${run.conclusion} (not deployed)`, url: run.url };
      } else return { status: 'failure', url: run.url };
    }
    if (!run && clock() - started > deployStartMs) return { status: 'not run (not checked)', url: null };
    if (clock() - started > deployTimeoutMs) return { status: 'timed out', url: run?.url ?? null };
    await sleep(pollMs);
  }
}
