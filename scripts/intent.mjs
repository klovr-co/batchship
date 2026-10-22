#!/usr/bin/env node
// UserPromptSubmit hook (Claude Code). When the user's own message asks for a hotfix or to ship when the work is done, records it for this
// session (2 hours), so the guard lets the agent merge. Agents cannot grant this themselves: only the user's prompt reaches here.
import { readFileSync } from 'node:fs';
import { findRoot } from './config.mjs';
import { intents, grant, UNLOCK_MS } from './lib.mjs';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
const kinds = intents(input.prompt);
const root = kinds.length && findRoot(input.cwd || process.cwd());
if (root) {
  try { grant(root, input.session_id, kinds); } catch { process.exit(0); } // never break the user's prompt
  const say = {
    hotfix: 'a hotfix: triage.mjs hotfix <name>, fix it there, push, open a normal (non-draft) PR to the live branch, wait for its CI, then merge it',
    ship: 'the batch shipped once everything they asked for in this session is done: finish every fix (each through fix.mjs done), make sure none of them is still open, then run ship.mjs --merge in the background; it opens the batch PR, marks it ready, waits for CI and merges it with a merge commit. Tell the user the result',
  };
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
    additionalContext: `batchship: the user asked for ${kinds.map((k) => say[k]).join('; and ')}. Allowed in this session for ${UNLOCK_MS / 3600_000} hours.` } }));
}
