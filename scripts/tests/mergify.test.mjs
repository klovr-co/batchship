import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergifyState, queueOutcome, usesMergify } from '../lib.mjs';
import { evaluate } from '../batch-guard.mjs';
import { DEFAULTS } from '../config.mjs';
import { prText } from '../ship.mjs';

const payload = (o) => `<!---\nDO NOT EDIT\n-*- Mergify Payload -*-\n${JSON.stringify(o)}\n-*- Mergify Payload End -*-\n-->\n# Merge Queue Status`;
const mg = (o) => ({ author: { login: 'mergify' }, body: payload(o) });

test('reads the newest Mergify payload, ignoring other comments', () => {
  const comments = [mg({ state: 'queued' }), { author: { login: 'me' }, body: '@mergifyio queue' }, mg({ state: 'checking' })];
  assert.equal(mergifyState(comments).state, 'checking');
  assert.equal(mergifyState([{ author: { login: 'me' }, body: payload({ state: 'x' }) }]), null);
});

test('queue outcome: merged, still going, dequeued only after we queued', () => {
  const since = Date.parse('2026-10-25T12:00:00Z');
  assert.equal(queueOutcome({ state: 'MERGED', comments: [] }, since).done, 'merged');
  assert.equal(queueOutcome({ state: 'OPEN', comments: [mg({ state: 'checking' })] }, since).state, 'checking');
  const out = mg({ state: 'dequeued', left_at: '2026-10-25T12:05:00Z', dequeue_reason: { code: 'CHECKS_FAILED', label: 'checks failed', checks: ['Lint'] } });
  assert.deepEqual(queueOutcome({ state: 'OPEN', comments: [out] }, since), { done: 'dequeued', reason: 'checks failed', checks: ['Lint'] });
  // A dequeue from an earlier try does not count as this one failing.
  const old = mg({ state: 'dequeued', left_at: '2026-10-25T11:00:00Z' });
  assert.equal(queueOutcome({ state: 'OPEN', comments: [old] }, since).done, null);
});

test('mergeVia: auto follows .mergify.yml, gh and mergify force it', () => {
  const d = mkdtempSync(join(tmpdir(), 'bs-mg-'));
  assert.equal(usesMergify(d, { mergeVia: 'auto' }), false);
  writeFileSync(join(d, '.mergify.yml'), 'queue_rules: []\n');
  assert.equal(usesMergify(d, { mergeVia: 'auto' }), true);
  assert.equal(usesMergify(d, { mergeVia: 'gh' }), false);
  assert.equal(usesMergify(mkdtempSync(join(tmpdir(), 'bs-mg-')), { mergeVia: 'mergify' }), true);
});

test('with Mergify, gh pr merge is the queue\'s, even with a hotfix unlocked', () => {
  const base = { branch: 'hotfix/x', head: 'a', marker: 'a', config: DEFAULTS, unlocked: new Set(['hotfix']) };
  assert.match(evaluate({ ...base, command: 'gh pr merge 5 --merge', mergify: true }).join(' '), /Mergify queue merges/);
  assert.deepEqual(evaluate({ ...base, command: 'gh pr merge 5 --merge' }), []);
  assert.deepEqual(evaluate({ ...base, command: 'gh pr ready 5', mergify: true }), []);
});

test('batch PR text says the queue merges it', () => {
  const t = prText({ batch: 'ship/day-20261025', live: 'staging', subjects: ['a (#1)'], mergify: true });
  assert.match(t.body, /Mergify merge queue merges this PR/);
  assert.doesNotMatch(prText({ batch: 'ship/day-20261025', live: 'staging', subjects: ['a (#1)'] }).body, /Mergify/);
});

import { humanGate } from '../ship.mjs';
test('humanPaths: a batch touching one waits for the human', () => {
  assert.equal(humanGate(['app/a.tsx', 'convex/schema.ts'], ['convex/schema.ts']), 'convex/schema.ts');
  assert.equal(humanGate(['app/a.tsx'], ['convex/schema.ts']), null);
  assert.equal(humanGate(['app/a.tsx']), null);
});

test('gh pr aimed at another repo (-R) is not this repo\'s business', () => {
  const base = { branch: 'staging', head: 'a', marker: 'a', config: DEFAULTS, mergify: true, repo: 'klovr-co/aldrent' };
  assert.deepEqual(evaluate({ ...base, command: 'gh pr merge 3 -R klovr-co/batchship --merge' }), []);
  assert.match(evaluate({ ...base, command: 'gh pr merge 3 -R klovr-co/aldrent --merge' }).join(' '), /Mergify/);
  assert.match(evaluate({ ...base, command: 'gh pr merge 3 --merge' }).join(' '), /Mergify/);
});
