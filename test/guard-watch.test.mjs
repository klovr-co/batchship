// #9.6: a PR watch alone is not a wait (T3's watch ends at merge without waking the agent); and the guard runs once
// per stop when both a user-level and a project-level hook call it.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { evaluate, runGuard, watchedPrsFromTranscript } from '../lib/guard.mjs';
import { recordSessionPr, shipStatePath, stateDir, writeJson } from '../lib/state.mjs';
import { removeRepo, tempRepo } from './helpers.mjs';

const repos = [];
after(() => repos.forEach(removeRepo));
const NOW = Date.parse('2026-10-30T12:00:00Z');
const alive = pid => pid === 4242;

function tugRepo({ vendored = false } = {}) {
  const files = { '.agents/config.yml': 'shipTarget: production\n', 'README.md': 'x\n' };
  if (vendored) files['.agents/tug/tug.mjs'] = '// vendored\n';
  const dir = tempRepo(files);
  repos.push(dir);
  return dir;
}

const claudeWatch = (name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } });
const codexWatch = (name, args) => ({ type: 'response_item', payload: { type: 'function_call', name, arguments: JSON.stringify(args) } });
const transcript = (dir, entries) => {
  const path = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(path, `${entries.map(e => JSON.stringify(e)).join('\n')}\n`);
  return path;
};

test('watched PRs from the transcript: Claude Code tool_use and Codex function_call; unwatch ends a watch', () => {
  const dir = tugRepo();
  const path = transcript(dir, [
    claudeWatch('mcp__t3-code__watch_pull_request', { number: 1087, repository: 'klovr-co/aldrent' }),
    codexWatch('mcp__t3-code__watch_pull_request', { url: 'https://github.com/klovr-co/aldrent/pull/1090' }),
    claudeWatch('mcp__t3-code__watch_pull_request', { number: 12 }),
    claudeWatch('mcp__t3-code__unwatch_pull_request', { number: 12 }),
    claudeWatch('Bash', { command: 'gh pr view 5' }),
  ]);
  assert.deepEqual(watchedPrsFromTranscript(path).sort(), [1087, 1090]);
  assert.deepEqual(watchedPrsFromTranscript(join(dir, 'missing.jsonl')), []);
});

test('evaluate: a PR waited on with a PR watch alone is unfollowed, every turn; a live ship or a merge clears it', () => {
  const ev = (pr, cli) => evaluate({ prs: [{ number: 1087, queued: false, watched: true, state: null, labels: ['queue'], open: true, ...pr }], message: 'Waiting for the merge.', isAlive: alive, now: NOW, cli }).map(r => r.key);
  assert.deepEqual(ev({}), ['pr-1087-watch-only']);
  assert.deepEqual(ev({ labels: null }), ['pr-1087-watch-only'], 'labels unknown: still a wait on a PR');
  assert.deepEqual(ev({ labels: ['needs-owner'] }), [], 'not queued: a watch for review comments is fine');
  assert.deepEqual(ev({ queued: true, labels: [] }), ['pr-1087-watch-only'], 'queued by this session, waited on by a watch');
  assert.deepEqual(ev({ open: false }), [], 'merged or closed');
  assert.deepEqual(ev({ state: { status: 'running', pid: 4242, updatedAt: new Date(NOW - 1000).toISOString() } }), [], 'a live tug ship follows it');
  assert.deepEqual(ev({ state: { status: 'done', code: 0 } }), []);
  const [reason] = evaluate({ prs: [{ number: 7, queued: false, watched: true, state: null, labels: ['queue'], open: true }], isAlive: alive, now: NOW, cli: 'node .agents/tug/tug.mjs ship' });
  assert.match(reason.text, /PR watch ends at merge without waking you.*run `node \.agents\/tug\/tug\.mjs ship 7 --background`/);
  assert.equal(reason.once, undefined, 'not once per session: every turn that ends on a watch alone');
});

test('the Stop hook blocks a turn whose only wait is a PR watch, even for a PR this session never shipped', () => {
  const dir = tugRepo({ vendored: true });
  const path = transcript(dir, [claudeWatch('mcp__t3-code__watch_pull_request', { number: 1087 })]);
  const payload = { hook_event_name: 'Stop', session_id: 'sess-w', cwd: dir, transcript_path: path, prompt_id: 'p1', last_assistant_message: 'Watching #1087 until it merges.' };
  const asked = [];
  const r = runGuard({ payload, env: {}, prInfo: n => { asked.push(n); return { labels: ['queue'], open: true }; }, isAlive: alive, now: NOW });
  assert.deepEqual(asked, [1087]);
  assert.match(r.reason, /^tug guard: PR #1087 is waited on with a PR watch alone.*`node \.agents\/tug\/tug\.mjs ship 1087 --background`/);
  // A ship that now follows it: the turn may end.
  stateDir(dir);
  writeJson(shipStatePath(dir, 1087), { status: 'running', pid: 4242, updatedAt: new Date(NOW).toISOString() });
  assert.equal(runGuard({ payload: { ...payload, prompt_id: 'p2' }, env: {}, prInfo: () => ({ labels: ['queue'], open: true }), isAlive: alive, now: NOW }).reason, null);
});

test('dedupe: the same stop seen by a user-level and a project-level hook blocks once', () => {
  const dir = tugRepo();
  recordSessionPr(dir, 'sess-d', { number: 5, queued: true });
  const payload = { hook_event_name: 'Stop', session_id: 'sess-d', cwd: dir, prompt_id: 'p1', stop_hook_active: false, last_assistant_message: 'Queued #5.' };
  const opts = { env: {}, prInfo: () => null, isAlive: () => false };
  const first = runGuard({ payload, ...opts, now: NOW });
  assert.match(first.reason, /PR #5 was queued but no tug ship is following it: run `tug ship 5 --background`/);
  const second = runGuard({ payload, ...opts, now: NOW + 200 });
  assert.deepEqual(second, { reason: null, duplicate: true });
  // The agent's next stop in the same turn is a new event (a hook continuation), not a duplicate.
  const later = runGuard({ payload: { ...payload, stop_hook_active: true, last_assistant_message: 'Started tug ship.' }, ...opts, now: NOW + 5000 });
  assert.equal(later.duplicate, undefined);
  // Long after the window, the same payload counts again (but the reason was already given this session).
  assert.equal(runGuard({ payload, ...opts, now: NOW + 60_000 }).duplicate, undefined);
});
