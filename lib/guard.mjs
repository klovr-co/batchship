// tug guard: the turn-end check, for any harness. It says why an agent should not end its turn yet:
//   (a) a PR this session queued is neither merged and deployed nor followed by a live `tug ship`;
//   (b) the last message asks the user a question, and no open PR from this session carries needs-owner (so the
//       owners, who get GitHub's notification for needs-owner, would not see it).
// Plain `tug guard` exits 1 with one reason line. `tug guard --hook claude|codex` is a Stop hook: it reads the hook
// payload on stdin and prints {"decision":"block","reason":...}. A hook blocks at most BLOCK_CAP times per turn, each
// reason at most once, and fails open: any error lets the turn end.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { guardPath, readJson, safeId, sessionFromEnv, sessionPath, shipRunning, shipStatePath, stateDir, worktrees, writeJson } from './state.mjs';
import { CONFIG_PATH } from './config.mjs';

export const BLOCK_CAP = 2;
const TRANSCRIPT_TAIL = 2 << 20;

/** A sentence after a "?" that answers it ("Is it live? Yes.") or shows it was rhetorical ("Why? Because …"). */
const ANSWER = /^(?:yes|no|nope|yep|yeah|because|not yet|not really|sure|correct|right|done|both|neither|none|all of them|mostly|partly)\b/i;

/**
 * True when the text asks the user a question: a sentence ending in "?" outside code, quotes and links, that the
 * same paragraph does not answer right away ("Is it live? Yes.", "Why? Because …" are not questions to the user).
 */
export function asksQuestion(text) {
  if (typeof text !== 'string' || !text) return false;
  const prose = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(~~~|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<[^>\n]*>/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .split('\n')
    .filter(l => !/^\s*>/.test(l))
    .join('\n');
  for (const paragraph of prose.split(/\n\s*\n/)) {
    const flat = paragraph.replace(/\s+/g, ' ');
    for (const m of flat.matchAll(/\?+(?=[\s"')\]*_]|$)/g)) {
      const before = flat.slice(0, m.index).split(/[.!?]\s/).pop().trim();
      const after = flat.slice(m.index + m[0].length).replace(/^[\s"')\]*_]+/, '');
      if (/^why$/i.test(before.replace(/^[*_"'(]+/, ''))) continue; // "Why? Because …": rhetorical
      if (after && ANSWER.test(after)) continue;
      return true;
    }
  }
  return false;
}

/** The text of one transcript entry when it is an assistant message (Claude Code or Codex JSONL), else null. */
function assistantText(entry) {
  const msg = entry?.type === 'assistant' ? entry.message : entry?.type === 'response_item' && entry.payload?.type === 'message' ? entry.payload : null;
  if (!msg || (msg.role && msg.role !== 'assistant')) return null;
  if (typeof msg.content === 'string') return msg.content || null;
  if (!Array.isArray(msg.content)) return null;
  const text = msg.content.filter(c => (c?.type === 'text' || c?.type === 'output_text') && typeof c.text === 'string').map(c => c.text).join('\n');
  return text || null;
}

/** The last assistant message in a JSONL transcript (read from its last 2 MB), or null. */
export function lastMessageFromTranscript(path) {
  if (!path || !existsSync(path)) return null;
  const fd = openSync(path, 'r');
  let text;
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    text = buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const found = assistantText(entry);
    if (found) return found;
  }
  return null;
}

/** The session's last assistant message: the payload's own field when the harness gives it, else the transcript. */
export function lastMessage(payload) {
  if (typeof payload?.last_assistant_message === 'string') return payload.last_assistant_message;
  return lastMessageFromTranscript(payload?.transcript_path);
}

/**
 * Why the turn should not end: [{ key, text }] (empty: it may end). Pure.
 * prs: [{ number, queued, state (its ship-<n>.json or null), labels (live labels or null), open (true|false|null) }].
 */
export function evaluate({ prs = [], message = null, isAlive, now = Date.now() }) {
  const reasons = [];
  for (const pr of prs.filter(p => p.queued)) {
    const s = pr.state;
    if (s?.status === 'done' && (s.code === 0 || s.waiting)) continue;
    if (shipRunning(s, { isAlive, now })) continue;
    if (s?.status === 'done') {
      // A finished run says its result once per session: the agent may have reported it, or the user dropped it.
      reasons.push({ key: `pr-${pr.number}-exit-${s.code}-${s.endedAt || s.updatedAt || ''}`, once: true, text: `PR #${pr.number} is not live: ${s.line}${s.next ? ` · next: ${s.next}` : ''}` });
    } else if (pr.open !== false) {
      // Once per session per PR; a PR GitHub says is closed or merged needs no follower (unknown: use the state).
      reasons.push({ key: `pr-${pr.number}-unfollowed`, once: true, text: `PR #${pr.number} was queued but no tug ship is following it: run \`tug ship ${pr.number} --background\` in a background shell (you are woken when it exits; don't poll).` });
    }
  }
  // Questions count only in a session that tracks a PR: elsewhere a question is ordinary conversation.
  if (prs.length && asksQuestion(message)) {
    const ownerPr = prs.some(p => p.open !== false && (p.labels ? p.labels.includes('needs-owner') : p.state?.waiting === 'needs-owner'));
    if (!ownerPr) {
      reasons.push({
        key: 'question',
        text: 'You asked the user a question, but no open PR from this session has needs-owner, so the owners get no notification. If it is a decision on a PR, put it there (first line "Needs owner: <the question>", then `gh pr edit <n> --add-label needs-owner` and `tug ship <n>`); if it is not, end your turn again.',
      });
    }
  }
  return reasons;
}

/**
 * Apply the cap: at most `cap` blocks per turn, each reason once per turn (a `once` reason once per session).
 * counter: the stored { turn, blocks, reasons, session } or null. stopHookActive (a hook continuation) is the same turn;
 * else a changed turn id, or no id, starts a new one. Returns { reason: text|null, counter }.
 */
export function decide({ reasons, counter, turnKey = null, stopHookActive = false, cap = BLOCK_CAP }) {
  // A hook continuation is always the same turn, whatever its id says (an id that changes per continuation must not
  // reset the cap); otherwise a new turn id, or no id at all, starts a new turn.
  const same = Boolean(counter) && (stopHookActive || (turnKey != null && counter.turn === turnKey));
  const session = [...(counter?.session || [])];
  let c = same ? { ...counter, turn: turnKey ?? counter.turn, reasons: [...(counter.reasons || [])], session } : { turn: turnKey, blocks: 0, reasons: [], session };
  if (c.blocks >= cap) return { reason: null, counter: c };
  const fresh = reasons.filter(r => !c.reasons.includes(r.key) && !c.session.includes(r.key));
  if (!fresh.length) return { reason: null, counter: c };
  c = { ...c, blocks: c.blocks + 1, reasons: [...c.reasons, ...fresh.map(r => r.key)], session: [...c.session, ...fresh.filter(r => r.once).map(r => r.key)].slice(-200) };
  return { reason: `tug guard: ${fresh.map(r => r.text).join(' Also: ')}`.replace(/\s*\n\s*/g, ' '), counter: c };
}

/** Live labels and state of a PR through gh (4 s at most), or null. */
export function ghPrInfo(cwd, number) {
  const r = spawnSync('gh', ['pr', 'view', String(number), '--json', 'labels,state'], { cwd, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return null;
  try {
    const p = JSON.parse(r.stdout);
    return { labels: (p.labels || []).map(l => l.name), open: p.state === 'OPEN' };
  } catch {
    return null;
  }
}

/**
 * Gather the session's PRs from the state files of every worktree of the repo at cwd. ids: the session ids to look
 * for (the hook payload's and the environment's). prInfo(number): live labels, or null to use the ship state.
 */
export function sessionPrs({ cwd, ids, prInfo = () => null, needLabels = false, isAlive, now = Date.now() }) {
  const byNumber = new Map();
  for (const dir of worktrees(cwd)) {
    for (const id of ids) {
      const session = readJson(sessionPath(dir, id));
      for (const pr of session?.prs || []) {
        const state = readJson(shipStatePath(dir, pr.number));
        const prev = byNumber.get(pr.number);
        if (!prev || String(state?.updatedAt || '') > String(prev.state?.updatedAt || '')) byNumber.set(pr.number, { number: pr.number, queued: Boolean(pr.queued || prev?.queued), state });
        else prev.queued = prev.queued || Boolean(pr.queued);
      }
    }
  }
  const prs = [...byNumber.values()];
  // Ask GitHub (at most 5 PRs) about every PR when the message asks a question (labels), and otherwise about queued
  // PRs that no live tug ship follows (closed or merged ones need none). A failed lookup keeps the stored state.
  const followed = p => (p.state?.status === 'done' && (p.state.code === 0 || p.state.waiting)) || shipRunning(p.state, { isAlive, now });
  const ask = needLabels ? prs : prs.filter(p => p.queued && !followed(p) && p.state?.status !== 'done');
  for (const pr of ask.slice(-5)) {
    let info = null;
    try {
      info = prInfo(pr.number);
    } catch { /* unreachable: stored state */ }
    if (info) Object.assign(pr, info);
  }
  return prs.map(p => ({ labels: null, open: null, ...p }));
}

/** The repo's root checkout when cwd is in a tug repo (one with .agents/config.yml), else null. */
export function tugRoot(cwd) {
  const all = worktrees(cwd);
  if (!all.length) return null;
  return all.some(dir => existsSync(join(dir, CONFIG_PATH))) ? all[0] : null;
}

/**
 * Run the guard. payload: the hook's stdin JSON (or {} for plain use). Returns { reason, probe }.
 * env and cwd are injectable; prInfo looks up live labels (tests pass a fake).
 */
export function runGuard({ payload = {}, env = process.env, cwd = process.cwd(), prInfo, isAlive, now = Date.now(), useCounter = true } = {}) {
  if (payload.tug_probe === true) return { reason: null, probe: true };
  if (payload.hook_event_name && payload.hook_event_name !== 'Stop') return { reason: null };
  const where = typeof payload.cwd === 'string' && existsSync(payload.cwd) ? payload.cwd : cwd;
  const root = tugRoot(where);
  if (!root) return { reason: null };
  const ids = [...new Set([payload.session_id, sessionFromEnv(env)].filter(safeId))];
  const message = lastMessage(payload);
  const prs = ids.length ? sessionPrs({ cwd: where, ids, prInfo: prInfo || (n => ghPrInfo(where, n)), needLabels: asksQuestion(message), isAlive, now }) : [];
  const reasons = evaluate({ prs, message, isAlive, now });
  if (!useCounter) return { reason: reasons.length ? `tug guard: ${reasons.map(r => r.text).join(' Also: ')}` : null };
  const id = ids[0];
  // No session id: nothing to count with, so block only a first stop, never a hook continuation.
  if (!id) return { reason: reasons.length && payload.stop_hook_active !== true ? `tug guard: ${reasons[0].text}` : null };
  stateDir(root);
  const path = guardPath(root, id);
  const turnKey = payload.turn_id || payload.prompt_id || null;
  const { reason, counter } = decide({ reasons, counter: readJson(path), turnKey, stopHookActive: payload.stop_hook_active === true });
  writeJson(path, { ...counter, updatedAt: new Date(now).toISOString() });
  return { reason };
}

/** Read all of stdin (empty when it is a terminal). */
export async function readStdin(stream = process.stdin) {
  if (stream.isTTY) return '';
  let data = '';
  for await (const chunk of stream) data += chunk;
  return data;
}

/**
 * The CLI: plain mode prints the reason and returns 1; hook mode prints the harness's block JSON and returns 0, and
 * on any error prints nothing and returns 0 (fail open).
 */
export async function guardMain({ hook = null, stdin = process.stdin, out = console.log, err = console.error, ...rest } = {}) {
  if (hook) {
    try {
      const text = await readStdin(stdin);
      const payload = text.trim() ? JSON.parse(text) : {};
      const { reason, probe } = runGuard({ payload, ...rest });
      if (probe) out(JSON.stringify({ tug_probe: 'ok' }));
      else if (reason) out(JSON.stringify({ decision: 'block', reason }));
    } catch (e) {
      err(`tug guard: ${e.message || e} (letting the turn end)`);
    }
    return 0;
  }
  const { reason } = runGuard({ payload: {}, useCounter: false, ...rest });
  if (reason) {
    out(reason);
    return 1;
  }
  return 0;
}
