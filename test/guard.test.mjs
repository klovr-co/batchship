import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { asksQuestion, BLOCK_CAP, decide, evaluate, guardMain, lastMessage, lastMessageFromTranscript, runGuard } from '../lib/guard.mjs';
import { recordSessionPr, shipStatePath, stateDir, writeJson } from '../lib/state.mjs';
import { assertInTmp, removeRepo, tempRepo, testGit } from './helpers.mjs';

const repos = [];
after(() => repos.forEach(removeRepo));
const NOW = Date.parse('2026-10-29T12:00:00Z');
const alive = pid => pid === 4242;
const running = (extra = {}) => ({ status: 'running', pid: 4242, updatedAt: new Date(NOW - 60_000).toISOString(), ...extra });
const done = (code, extra = {}) => ({ status: 'done', code, line: `shiplane ship #5: result ${code}`, next: code ? 'do the thing' : null, updatedAt: new Date(NOW).toISOString(), ...extra });

test('asksQuestion: a sentence ending in ? in prose, not in code, quotes or links', () => {
  assert.equal(asksQuestion('Done. Want me to ship it?'), true);
  assert.equal(asksQuestion('Should I drop the table? If you don\'t answer I will keep it.'), true);
  assert.equal(asksQuestion('Ready (ship it?)'), true);
  assert.equal(asksQuestion('Shipped #5: merged abc1234, deploy success.'), false);
  assert.equal(asksQuestion('Ran `curl https://x/?a=1` and ```\nwhat?\n```'), false);
  assert.equal(asksQuestion('See https://example.com/search?q=x for details.'), false);
  assert.equal(asksQuestion('> Is it live?\nIt is live.'), false);
  assert.equal(asksQuestion(null), false);
  assert.equal(asksQuestion('Is it live? Yes. Deployed abc1234.'), false, 'answered in the same paragraph');
  assert.equal(asksQuestion('Why? Because the batch was red.'), false, 'rhetorical');
  assert.equal(asksQuestion('Is it live?\n\nYes.'), true, 'the answer is not in the same paragraph');
  assert.equal(asksQuestion('Is it live? Yes. Want me to ship the other one?'), true, 'a later question still counts');
});

test('lastMessage: the payload field first, else the transcript (Claude Code and Codex JSONL)', () => {
  const dir = tempRepo();
  repos.push(dir);
  const claude = join(dir, 'claude.jsonl');
  writeFileSync(claude, [
    { type: 'user', message: { role: 'user', content: 'hi' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Ship it?' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } },
    { type: 'tools-used' },
  ].map(JSON.stringify).join('\n') + '\nnot json\n');
  assert.equal(lastMessageFromTranscript(claude), 'Ship it?');
  const codex = join(dir, 'codex.jsonl');
  writeFileSync(codex, [
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Merge now?' }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ].map(JSON.stringify).join('\n'));
  assert.equal(lastMessageFromTranscript(codex), 'Merge now?');
  assert.equal(lastMessage({ last_assistant_message: 'from payload', transcript_path: claude }), 'from payload');
  assert.equal(lastMessage({ transcript_path: claude }), 'Ship it?');
  assert.equal(lastMessage({ transcript_path: join(dir, 'missing.jsonl') }), null);
});

test('evaluate (a): a queued PR must be live or followed by a live shiplane ship', () => {
  const one = (state, extra = {}) => evaluate({ prs: [{ number: 5, queued: true, state, labels: null, open: null, ...extra }], message: 'ok', isAlive: alive, now: NOW });
  assert.deepEqual(one(done(0)), [], 'merged and deployed');
  assert.deepEqual(one(running()), [], 'a live shiplane ship follows it');
  assert.deepEqual(one(done(2, { waiting: 'needs-owner' })), [], 'refused for needs-owner: the owner\'s turn');
  assert.deepEqual(one(done(2, { waiting: 'hold' })), []);
  assert.match(one(running({ pid: 99 }))[0].text, /no shiplane ship is following it: run `shiplane ship 5 --background`/, 'pid gone');
  assert.match(one(running({ updatedAt: new Date(NOW - 3_600_000).toISOString() }))[0].text, /no shiplane ship is following/, 'stale heartbeat (pid reused)');
  assert.match(one(null)[0].text, /no shiplane ship is following/, 'no state at all');
  assert.equal(one(null)[0].once, true, 'once per session per PR');
  assert.deepEqual(one(running({ pid: 99 }), { open: false }), [], 'GitHub says closed or merged: nothing to follow');
  assert.equal(one(running({ pid: 99 }), { open: null }).length, 1, 'GitHub unreachable: the stored state decides');
  const failed = one(done(4));
  assert.equal(failed[0].key, 'pr-5-exit-4-2026-10-29T12:00:00.000Z');
  assert.equal(failed[0].once, true);
  assert.equal(failed[0].text, 'PR #5 is not live: shiplane ship #5: result 4 · next: do the thing');
  assert.deepEqual(evaluate({ prs: [{ number: 5, queued: false, state: done(3) }], message: '', isAlive: alive, now: NOW }), [], 'never queued: not this rule');
});

test('evaluate (b): a question needs an open needs-owner PR from this session', () => {
  const q = 'Should I drop the old table?';
  const ev = prs => evaluate({ prs, message: q, isAlive: alive, now: NOW }).map(r => r.key);
  assert.deepEqual(ev([]), [], 'no tracked PR: a question is ordinary conversation');
  assert.deepEqual(evaluate({ prs: [], message: 'Which file did you mean?', isAlive: alive, now: NOW }), []);
  assert.deepEqual(ev([{ number: 5, queued: false, state: null, labels: [], open: true }]), ['question']);
  assert.deepEqual(ev([{ number: 5, queued: false, state: null, labels: ['needs-owner'], open: true }]), []);
  assert.deepEqual(ev([{ number: 5, queued: false, state: done(2, { waiting: 'needs-owner' }), labels: null, open: null }]), [], 'no live labels: the ship state says needs-owner');
  assert.deepEqual(ev([{ number: 5, queued: false, state: done(2, { waiting: 'needs-owner' }), labels: [], open: true }]), ['question'], 'live labels win: needs-owner was removed');
  assert.deepEqual(ev([{ number: 5, queued: false, state: null, labels: ['needs-owner'], open: false }]), ['question'], 'a closed PR does not count');
  assert.deepEqual(evaluate({ prs: [], message: 'All done.', isAlive: alive, now: NOW }), []);
});

test('decide: at most 2 blocks per turn, each reason once; a new turn starts over', () => {
  const r = key => ({ key, text: `reason ${key}` });
  let { reason, counter } = decide({ reasons: [r('a')], counter: null, turnKey: 't1' });
  assert.equal(reason, 'shiplane guard: reason a');
  ({ reason, counter } = decide({ reasons: [r('a')], counter, turnKey: 't1' }));
  assert.equal(reason, null, 'the same reason does not block twice');
  ({ reason, counter } = decide({ reasons: [r('a'), r('b')], counter, turnKey: 't1' }));
  assert.equal(reason, 'shiplane guard: reason b');
  ({ reason, counter } = decide({ reasons: [r('c')], counter, turnKey: 't1' }));
  assert.equal(reason, null, `cap of ${BLOCK_CAP}`);
  assert.equal(counter.blocks, 2);
  ({ reason } = decide({ reasons: [r('a')], counter, turnKey: 't2' }));
  assert.equal(reason, 'shiplane guard: reason a', 'new turn id: counts reset');
  // Without a turn id: a Stop that is a hook continuation is the same turn; one that is not starts a new one.
  let c2 = decide({ reasons: [r('a')], counter: null, stopHookActive: false }).counter;
  assert.equal(decide({ reasons: [r('a')], counter: c2, stopHookActive: true }).reason, null);
  c2 = decide({ reasons: [r('b')], counter: c2, stopHookActive: true }).counter;
  assert.equal(decide({ reasons: [r('c')], counter: c2, stopHookActive: true }).reason, null, 'cap without turn ids');
  assert.equal(decide({ reasons: [r('a')], counter: c2, stopHookActive: false }).reason, 'shiplane guard: reason a');
  assert.equal(decide({ reasons: [r('a'), r('b')], counter: null }).reason, 'shiplane guard: reason a Also: reason b', 'one line');
  // A turn id that changes on every continuation must not reset the cap: stop_hook_active means the same turn.
  let c4 = null;
  let blocks = 0;
  for (const [i, id] of ['a', 'b', 'c'].entries()) {
    const d = decide({ reasons: [r(`x${i}`)], counter: c4, turnKey: id, stopHookActive: i > 0 });
    c4 = d.counter;
    if (d.reason) blocks++;
  }
  assert.equal(blocks, 2, 'ids a, b, c with stop_hook_active: at most 2 blocks');
  // A finished run's result blocks once per session, not at the start of every later turn.
  const once = { key: 'pr-5-exit-4-t', once: true, text: 'failed' };
  const c3 = decide({ reasons: [once], counter: null, turnKey: 'p1' }).counter;
  assert.equal(decide({ reasons: [once], counter: c3, turnKey: 'p2' }).reason, null);
  assert.equal(decide({ reasons: [once, r('q')], counter: c3, turnKey: 'p2' }).reason, 'shiplane guard: reason q');
});

/** A shiplane repo (config present) with a worktree; the session's records live in the worktree, as shiplane ship writes them. */
function shiplaneRepo() {
  const dir = tempRepo({ '.agents/config.yml': 'shipTarget: production\n', 'README.md': 'x\n' });
  repos.push(dir);
  const wt = assertInTmp(dir) + '-wt';
  testGit(dir, ['worktree', 'add', '-q', '-b', 'feature', wt]);
  repos.push(assertInTmp(wt));
  return { root: dir, wt };
}

const hook = async (payload, opts = {}) => {
  const out = [];
  const err = [];
  const stdin = Readable.from([typeof payload === 'string' ? payload : JSON.stringify(payload)]);
  const code = await guardMain({ hook: 'claude', stdin, out: t => out.push(t), err: t => err.push(t), env: {}, prInfo: () => null, isAlive: alive, now: NOW, ...opts });
  return { code, out, err };
};

test('the Stop hook in a temp repo: blocks with the Claude Code JSON, twice at most, then lets the turn end', async () => {
  const { root, wt } = shiplaneRepo();
  recordSessionPr(wt, 'sess-1', { number: 5, queued: true });
  stateDir(wt);
  writeJson(shipStatePath(wt, 5), running({ pid: 99 }));
  const payload = { hook_event_name: 'Stop', session_id: 'sess-1', cwd: root, stop_hook_active: false, prompt_id: 'p1', last_assistant_message: 'Queued #5. Anything else?' };
  const first = await hook(payload);
  assert.equal(first.code, 0);
  const json = JSON.parse(first.out[0]);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /^shiplane guard: PR #5 was queued but no shiplane ship is following it.* Also: You asked the user a question/);
  const second = await hook({ ...payload, stop_hook_active: true });
  assert.deepEqual(second.out, [], 'both reasons were given this turn: no second block for them');
  writeJson(shipStatePath(wt, 5), done(3));
  const third = await hook({ ...payload, stop_hook_active: true });
  assert.match(JSON.parse(third.out[0]).reason, /PR #5 is not live: shiplane ship #5: result 3/);
  writeJson(shipStatePath(wt, 5), done(4));
  assert.deepEqual((await hook({ ...payload, stop_hook_active: true })).out, [], 'cap reached: the turn ends');
  const nextTurn = await hook({ ...payload, prompt_id: 'p2', last_assistant_message: 'Done.' });
  assert.match(JSON.parse(nextTurn.out[0]).reason, /PR #5 is not live/, 'a new prompt is a new turn');
  writeJson(shipStatePath(wt, 5), running());
  assert.deepEqual((await hook({ ...payload, prompt_id: 'p3', last_assistant_message: 'Done.' })).out, [], 'a live shiplane ship follows it: the turn ends');
  // The session id from the environment works too (plain mode, no counter).
  const out = [];
  const code = await guardMain({ env: { CLAUDE_CODE_SESSION_ID: 'sess-1' }, cwd: wt, out: t => out.push(t), prInfo: () => null, isAlive: () => false, now: NOW });
  assert.equal(code, 1);
  assert.equal(out.length, 1);
  assert.match(out[0], /^shiplane guard: PR #5 was queued but no shiplane ship is following it/);
});

test('the Stop hook fails open and stays out of the way', async () => {
  const { root } = shiplaneRepo();
  for (const bad of ['not json', '{"session_id": "../../etc"}', '[]']) {
    const r = await hook(bad);
    assert.equal(r.code, 0, bad);
    assert.deepEqual(r.out, [], bad);
  }
  const broken = await hook({ hook_event_name: 'Stop', session_id: 's', cwd: root }, { prInfo: () => { throw new Error('boom'); }, isAlive: () => { throw new Error('boom'); } });
  assert.deepEqual(broken.out, []);
  const notShiplane = tempRepo();
  repos.push(notShiplane);
  assert.deepEqual((await hook({ hook_event_name: 'Stop', session_id: 's', cwd: notShiplane, last_assistant_message: 'Which one?' })).out, [], 'not a shiplane repo: no opinion');
  assert.deepEqual((await hook({ hook_event_name: 'SubagentStop', session_id: 's', cwd: root, last_assistant_message: 'Which one?' })).out, [], 'only Stop');
  assert.deepEqual((await hook({ shiplane_probe: true })).out, ['{"shiplane_probe":"ok"}'], 'doctor\'s probe');
  assert.deepEqual(runGuard({ payload: { hook_event_name: 'Stop', cwd: root, last_assistant_message: 'Fine.' }, env: {} }), { reason: null });
  // No session id anywhere: no tracked PRs, so a question is ordinary conversation.
  const noId = { hook_event_name: 'Stop', cwd: root, last_assistant_message: 'Which file did you mean?' };
  assert.deepEqual((await hook({ ...noId, stop_hook_active: false })).out, []);
  assert.deepEqual((await hook({ ...noId, session_id: 'fresh-session' })).out, [], 'a session with no PRs: no block');
});

test('live labels are looked up only when the message asks a question', async () => {
  const { root } = shiplaneRepo();
  recordSessionPr(root, 'sess-2', { number: 8 });
  const asked = [];
  const prInfo = n => {
    asked.push(n);
    return { labels: ['needs-owner'], open: true };
  };
  assert.deepEqual((await hook({ hook_event_name: 'Stop', session_id: 'sess-2', cwd: root, last_assistant_message: 'All done.' }, { prInfo })).out, []);
  assert.deepEqual(asked, []);
  assert.deepEqual((await hook({ hook_event_name: 'Stop', session_id: 'sess-2', cwd: root, last_assistant_message: 'Drop it?' }, { prInfo })).out, [], 'the PR has needs-owner: the owners were told');
  assert.deepEqual(asked, [8]);
});

test('an unfollowed PR blocks once per session, and not at all when GitHub says it is closed or merged', async () => {
  const { root } = shiplaneRepo();
  recordSessionPr(root, 'sess-u', { number: 6, queued: true });
  writeJson(shipStatePath(root, 6), running({ pid: 99 }));
  const base = { hook_event_name: 'Stop', session_id: 'sess-u', cwd: root, last_assistant_message: 'Done.' };
  assert.match(JSON.parse((await hook({ ...base, prompt_id: 'p1' })).out[0]).reason, /PR #6 was queued but no shiplane ship/);
  assert.deepEqual((await hook({ ...base, prompt_id: 'p2' })).out, [], 'already said this session');
  recordSessionPr(root, 'sess-m', { number: 6, queued: true });
  const asked = [];
  const merged = await hook({ ...base, session_id: 'sess-m', prompt_id: 'p1' }, { prInfo: n => (asked.push(n), { labels: [], open: false }) });
  assert.deepEqual(merged.out, []);
  assert.deepEqual(asked, [6], 'looked up the unfollowed PR');
  recordSessionPr(root, 'sess-f', { number: 6, queued: true });
  const failing = await hook({ ...base, session_id: 'sess-f', prompt_id: 'p1' }, { prInfo: () => { throw new Error('gh down'); } });
  assert.match(JSON.parse(failing.out[0]).reason, /PR #6 was queued/, 'lookup failed: the stored state decides');
});
