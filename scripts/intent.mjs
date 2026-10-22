#!/usr/bin/env node
// UserPromptSubmit hook (Claude Code). When the user's own message asks for a hotfix or to ship now, records it for this
// session (2 hours), so the guard lets the agent merge. Agents cannot grant this themselves: only the user's prompt reaches here.
import { readFileSync } from 'node:fs';
import { findRoot } from './config.mjs';
import { intents, grant, UNLOCK_MS } from './lib.mjs';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch {}
const kinds = intents(input.prompt);
const root = kinds.length && findRoot(input.cwd || process.cwd());
if (root) {
  grant(root, input.session_id, kinds);
  const say = {
    hotfix: 'a hotfix: triage.mjs hotfix <name>, fix it there, push, open a normal (non-draft) PR to the live branch, wait for its CI, then merge it',
    'ship-now': 'to ship now: ship.mjs --now <batch> (or ship the current batch) marks its PR ready, waits for CI and merges, without waiting for the day',
  };
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit',
    additionalContext: `batchship: the user asked for ${kinds.map((k) => say[k]).join('; and ')}. Allowed in this session for ${UNLOCK_MS / 3600_000} hours.` } }));
}
