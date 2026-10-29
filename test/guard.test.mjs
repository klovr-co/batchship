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
const done = (code, extra = {}) => ({ status: 'done', code, line: `tug ship #5: result ${code}`, next: code ? 'do the thing' : null, updatedAt: new Date(NOW).toISOString(), ...extra });

test('asksQuestion: a sentence ending in ? in prose, not in code, quotes or links', () => {
  assert.equal(asksQuestion('Done. Want me to ship it?'), true);
  assert.equal(asksQuestion('Should I drop the table? If you don\'t answer I will keep it.'), true);
  assert.equal(asksQuestion('Ready (ship it?)'), true);
  assert.equal(asksQuestion('Shipped #5: merged abc1234, deploy success.'), false);
  assert.equal(asksQuestion('Ran `curl https://x/?a=1` and ```\nwhat?\n```'), false);
  assert.equal(asksQuestion('See https://example.com/search?q=x for details.'), false);
  assert.equal(asksQuestion('> Is it live?\nIt is live.'), false);
  assert.equal(asksQuestion(null), false);
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

test('evaluate (a): a queued PR must be live or followed by a live tug ship', () => {
  const one = (state, extra = {}) => evaluate({ prs: [{ number: 5, queued: true, state, labels: null, open: null, ...extra }], message: 'ok', isAlive: alive, now: NOW });
  assert.deepEqual(one(done(0)), [], 'merged and deployed');
  assert.deepEqual(one(running()), [], 'a live tug ship follows it');
  assert.deepEqual(one(done(2, { waiting: 'needs-owner' })), [], 'refused for needs-owner: the owner\'s turn');
  assert.deepEqual(one(done(2, { waiting: 'hold' })), []);
  assert.match(one(running({ pid: 99 }))[0].text, /no tug ship is following it: run `tug ship 5 --background`/, 'pid gone');
  assert.match(one(running({ updatedAt: new Date(NOW - 3_600_000).toISOString() }))[0].text, /no tug ship is following/, 'stale heartbeat (pid reused)');
  assert.match(one(null)[0].text, /no tug ship is following/, 'no state at all');
  const failed = one(done(4));
  assert.equal(failed[0].key, 'pr-5-exit-4');
  assert.equal(failed[0].text, 'PR #5 is not live: tug ship #5: result 4 · next: do the thing');
  assert.deepEqual(evaluate({ prs: [{ number: 5, queued: false, state: done(3) }], message: '', isAlive: alive, now: NOW }), [], 'never queued: not this rule');
});

test('evaluate (b): a question needs an open needs-owner PR from this session', () => {
  const q = 'Should I drop the old table?';
  const ev = prs => evaluate({ prs, message: q, isAlive: alive, now: NOW }).map(r => r.key);
  assert.deepEqual(ev([]), ['question']);
  assert.deepEqual(ev([{ number: 5, queued: false, state: null, labels: ['needs-owner'], open: true }]), []);
  assert.deepEqual(ev([{ number: 5, queued: false, state: done(2, { waiting: 'needs-owner' }), labels: null, open: null }]), [], 'no live labels: the ship state says needs-owner');
  assert.deepEqual(ev([{ number: 5, queued: false, state: done(2, { waiting: 'needs-owner' }), labels: [], open: true }]), ['question'], 'live labels win: needs-owner was removed');
  assert.deepEqual(ev([{ number: 5, queued: false, state: null, labels: ['needs-owner'], open: false }]), ['question'], 'a closed PR does not count');
  assert.deepEqual(evaluate({ prs: [], message: 'All done.', isAlive: alive, now: NOW }), []);
});

test('decide: at most 2 blocks per turn, each reason once; a new turn starts over', () => {
  const r = key => ({ key, text: `reason ${key}` });
  let { reason, counter } = decide({ reasons: [r('a')], counter: null, turnKey: 't1' });
  assert.equal(reason, 'tug guard: reason a');
  ({ reason, counter } = decide({ reasons: [r('a')], counter, turnKey: 't1' }));
  assert.equal(reason, null, 'the same reason does not block twice');
  ({ reason, counter } = decide({ reasons: [r('a'), r('b')], counter, turnKey: 't1' }));
  assert.equal(reason, 'tug guard: reason b');
  ({ reason, counter } = decide({ reasons: [r('c')], counter, turnKey: 't1' }));
  assert.equal(reason, null, `cap of ${BLOCK_CAP}`);
  assert.equal(counter.blocks, 2);
  ({ reason } = decide({ reasons: [r('a')], counter, turnKey: 't2' }));
  assert.equal(reason, 'tug guard: reason a', 'new turn id: counts reset');
  // Without a turn id: a Stop that is a hook continuation is the same turn; one that is not starts a new one.
  let c2 = decide({ reasons: [r('a')], counter: null, stopHookActive: false }).counter;
  assert.equal(decide({ reasons: [r('a')], counter: c2, stopHookActive: true }).reason, null);
  c2 = decide({ reasons: [r('b')], counter: c2, stopHookActive: true }).counter;
  assert.equal(decide({ reasons: [r('c')], counter: c2, stopHookActive: true }).reason, null, 'cap without turn ids');
  assert.equal(decide({ reasons: [r('a')], counter: c2, stopHookActive: false }).reason, 'tug guard: reason a');
  assert.equal(decide({ reasons: [r('a'), r('b')], counter: null }).reason, 'tug guard: reason a Also: reason b', 'one line');
});

/** A tug repo (config present) with a worktree; the session's records live in the worktree, as tug ship writes them. */
function tugRepo() {
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
  const { root, wt } = tugRepo();
  recordSessionPr(wt, 'sess-1', { number: 5, queued: true });
  stateDir(wt);
  writeJson(shipStatePath(wt, 5), running({ pid: 99 }));
  const payload = { hook_event_name: 'Stop', session_id: 'sess-1', cwd: root, stop_hook_active: false, prompt_id: 'p1', last_assistant_message: 'Queued #5. Anything else?' };
  const first = await hook(payload);
  assert.equal(first.code, 0);
  const json = JSON.parse(first.out[0]);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /^tug guard: PR #5 was queued but no tug ship is following it.* Also: You asked the user a question/);
  const second = await hook({ ...payload, stop_hook_active: true });
  assert.deepEqual(second.out, [], 'both reasons were given this turn: no second block for them');
  writeJson(shipStatePath(wt, 5), done(3));
  const third = await hook({ ...payload, stop_hook_active: true });
  assert.match(JSON.parse(third.out[0]).reason, /PR #5 is not live: tug ship #5: result 3/);
  writeJson(shipStatePath(wt, 5), done(4));
  assert.deepEqual((await hook({ ...payload, stop_hook_active: true })).out, [], 'cap reached: the turn ends');
  const nextTurn = await hook({ ...payload, prompt_id: 'p2', last_assistant_message: 'Done.' });
  assert.match(JSON.parse(nextTurn.out[0]).reason, /PR #5 is not live/, 'a new prompt is a new turn');
  writeJson(shipStatePath(wt, 5), running());
  assert.deepEqual((await hook({ ...payload, prompt_id: 'p3', last_assistant_message: 'Done.' })).out, [], 'a live tug ship follows it: the turn ends');
  // The session id from the environment works too (plain mode, no counter).
  const out = [];
  const code = await guardMain({ env: { CLAUDE_CODE_SESSION_ID: 'sess-1' }, cwd: wt, out: t => out.push(t), prInfo: () => null, isAlive: () => false, now: NOW });
  assert.equal(code, 1);
  assert.equal(out.length, 1);
  assert.match(out[0], /^tug guard: PR #5 was queued but no tug ship is following it/);
});

test('the Stop hook fails open and stays out of the way', async () => {
  const { root } = tugRepo();
  for (const bad of ['not json', '{"session_id": "../../etc"}', '[]']) {
    const r = await hook(bad);
    assert.equal(r.code, 0, bad);
    assert.deepEqual(r.out, [], bad);
  }
  const broken = await hook({ hook_event_name: 'Stop', session_id: 's', cwd: root }, { prInfo: () => { throw new Error('boom'); }, isAlive: () => { throw new Error('boom'); } });
  assert.deepEqual(broken.out, []);
  const notTug = tempRepo();
  repos.push(notTug);
  assert.deepEqual((await hook({ hook_event_name: 'Stop', session_id: 's', cwd: notTug, last_assistant_message: 'Which one?' })).out, [], 'not a tug repo: no opinion');
  assert.deepEqual((await hook({ hook_event_name: 'SubagentStop', session_id: 's', cwd: root, last_assistant_message: 'Which one?' })).out, [], 'only Stop');
  assert.deepEqual((await hook({ tug_probe: true })).out, ['{"tug_probe":"ok"}'], 'doctor\'s probe');
  assert.deepEqual(runGuard({ payload: { hook_event_name: 'Stop', cwd: root, last_assistant_message: 'Fine.' }, env: {} }), { reason: null });
});

test('live labels are looked up only when the message asks a question', async () => {
  const { root } = tugRepo();
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
