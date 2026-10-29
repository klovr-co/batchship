import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, dequeueReason, EXIT, ship, waitingFor } from '../lib/ship.mjs';
import { CONFIG, World } from './fake-mergify.mjs';

const comments = w => w.comments.filter(c => c.body === '@mergifyio queue');

test('classify reads the real Mergify check titles', () => {
  const c = (title, status = 'completed', summary = '') => classify({ title, status, summary });
  assert.equal(c('Merge queue is ready'), 'ready');
  assert.equal(c('Waiting for queue conditions to match'), 'waiting');
  assert.equal(c('Waiting for queue conditions', 'in_progress'), 'waiting');
  assert.equal(c('Your merge queue conditions are under evaluation', 'in_progress'), 'pending');
  assert.equal(c('Running merge queue checks', 'in_progress'), 'queued');
  assert.equal(c('Merged via merge queue'), 'merged');
  assert.equal(c('Dequeued — pull request manually updated'), 'dequeued-push');
  assert.equal(c('Dequeued — pull request merged manually'), 'merged');
  assert.equal(c('Dequeued — checks failed'), 'dequeued');
  assert.equal(c('Something new', 'in_progress'), 'queued');
  assert.equal(classify(null), 'none');
  assert.equal(waitingFor({ summary: '### ⏳ Waiting for queue conditions\n**Waiting for**\n- ⏳ `-conflict`\n' }), '-conflict');
  assert.equal(dequeueReason({ title: 'Dequeued — checks failed', summary: '**Reason**\n\nThe merge conditions cannot be satisfied\n' }), 'The merge conditions cannot be satisfied');
});

test('happy path: readies a draft, labels, posts the command once, waits for merge and deploy', async () => {
  const w = new World({ pr: { isDraft: true }, deploys: { 'deploy.yml': { conclusion: 'success' } } });
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.ok, out.line);
  assert.equal(out.line, 'tug ship #7: merged mmmmmmm into main · deploy: deploy.yml success · live: https://app.example.com');
  assert.ok(w.calls.some(c => c.name === 'ready'));
  assert.deepEqual(w.calls.find(c => c.name === 'addLabels').args, [['queue']]);
  assert.equal(comments(w).length, 1, 'the label alone does not queue: one command, posted once');
  assert.equal(out.next, undefined);
});

test('refuses needs-owner and hold, touching nothing', async () => {
  for (const label of ['needs-owner', 'hold']) {
    const w = new World({ pr: { labels: [label], isDraft: true } });
    const out = await ship(w.opts());
    assert.equal(out.code, EXIT.refused);
    assert.match(out.line, new RegExp(`${label} label`));
    assert.ok(out.next);
    assert.deepEqual(w.calls, [], `${label}: no ready, label or comment`);
  }
});

test('refuses a PR into another branch, and a closed PR', async () => {
  const w = new World({ pr: { baseRefName: 'develop' } });
  assert.equal((await ship(w.opts())).code, EXIT.refused);
  const closed = new World({ pr: { state: 'CLOSED' } });
  assert.equal((await ship(closed.opts())).code, EXIT.refused);
});

test('--now adds hotfix, and refuses when another open PR has hotfix', async () => {
  const taken = new World({ otherHotfix: [3] });
  const refused = await ship(taken.opts({ now: true }));
  assert.equal(refused.code, EXIT.refused);
  assert.match(refused.line, /#3 already has hotfix/);
  assert.deepEqual(taken.calls, []);

  const w = new World({ deploys: {} });
  const out = await ship(w.opts({ now: true, config: { ...CONFIG, deployWorkflows: [] } }));
  assert.equal(out.code, EXIT.ok, out.line);
  assert.deepEqual(w.calls.find(c => c.name === 'addLabels').args, [['queue', 'hotfix']]);
  assert.match(out.line, /deploy: none configured/);
});

test('a push dequeues it: re-posts only after Mergify has registered the push', async () => {
  const w = new World({ registerDelayMs: 50_000, deploys: { 'deploy.yml': { conclusion: 'success' } } });
  w.at(5 * 60_000, () => w.push('b'.repeat(40)));
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.ok, out.line);
  const posts = comments(w);
  assert.equal(posts.length, 2);
  const pushAt = Date.parse('2026-10-29T08:00:00Z') + 5 * 60_000;
  assert.ok(posts[1].t >= pushAt + 50_000, `re-posted ${(posts[1].t - pushAt) / 1000} s after the push, before Mergify registered it`);
  assert.equal(posts[1].head, 'b'.repeat(40));
});

test('a command posted too early is cancelled by Mergify; tug posts again', async () => {
  const w = new World({ ignoreComments: 1, deploys: {} });
  const out = await ship(w.opts({ config: { ...CONFIG, deployWorkflows: [] } }));
  assert.equal(out.code, EXIT.ok, out.line);
  assert.equal(comments(w).length, 2);
  assert.ok(comments(w)[1].t - comments(w)[0].t > 3 * 60_000, 'waits the grace period before posting again');
});

test('already queued: does not post again', async () => {
  const w = new World({ deploys: {} });
  w.checks.set(w.pr.headRefOid, w.check('in_progress', 'Running merge queue checks'));
  w.at(60_000, () => { w.pr.state = 'MERGED'; w.pr.mergeCommit = { oid: w.mergeSha }; });
  const out = await ship(w.opts({ config: { ...CONFIG, deployWorkflows: [] } }));
  assert.equal(out.code, EXIT.ok);
  assert.equal(comments(w).length, 0);
});

test('a red batch: exit 3 with Mergify\'s reason and the next step', async () => {
  const w = new World();
  w.failBatch = true;
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.dequeued);
  assert.match(out.line, /Mergify took it out of the queue: The merge conditions cannot be satisfied due to failing checks/);
  assert.match(out.next, /fix the failure, push, then run tug ship 7 again/);
});

test('an old "Dequeued" answer from before this run is not read as a new failure', async () => {
  const w = new World({ deploys: {} });
  w.checks.set(w.pr.headRefOid, { ...w.check('completed', 'Dequeued — checks failed'), completedAt: '2026-10-29T07:00:00Z' });
  const out = await ship(w.opts({ config: { ...CONFIG, deployWorkflows: [] } }));
  assert.equal(out.code, EXIT.ok, out.line);
});

test('waiting on a conflict: exit 3, next step says merge the ship branch in', async () => {
  const w = new World();
  w.checks.set(w.pr.headRefOid, w.check('completed', 'Waiting for queue conditions to match', '**Waiting for**\n- ⏳ `-conflict`\n'));
  w.queueDelayMs = 10 ** 9; // Mergify never queues it
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.dequeued);
  assert.match(out.line, /waiting for -conflict/);
  assert.match(out.next, /merge origin\/main into the branch/);
});

test('someone adds hold while queued: stops with exit 2', async () => {
  const w = new World();
  w.at(5 * 60_000, () => w.pr.labels.push('hold'));
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.refused);
  assert.match(out.line, /someone added hold/);
});

test('deploy failure: exit 4, names the run', async () => {
  const w = new World({ deploys: { 'deploy.yml': { conclusion: 'failure' } } });
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.deployFailed);
  assert.match(out.line, /deploy: deploy.yml failure/);
  assert.match(out.next, /https:\/\/ci\/deploy.yml/);
});

test('a deploy that never starts is reported as not run (not checked)', async () => {
  const w = new World({ deploys: {} });
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.ok);
  assert.match(out.line, /deploy.yml not run \(not checked\)/);
});

test('times out with exit 5', async () => {
  const w = new World({ mergeAfterMs: 10 ** 9 });
  const out = await ship(w.opts({ timeoutMs: 60 * 60_000 }));
  assert.equal(out.code, EXIT.timeout);
  assert.match(out.line, /still not merged after 60 min/);
});

test('an already merged PR: skips the queue, waits for the deploy', async () => {
  const w = new World({ pr: { state: 'MERGED', mergeCommit: { oid: 'c'.repeat(40) }, labels: ['hold'] }, mergeSha: 'c'.repeat(40) });
  w.runs.set(`deploy.yml@${'c'.repeat(40)}`, { id: 1, status: 'completed', conclusion: 'success', url: 'u', headSha: 'c'.repeat(40) });
  const out = await ship(w.opts());
  assert.equal(out.code, EXIT.ok, out.line);
  assert.deepEqual(w.calls, []);
});
