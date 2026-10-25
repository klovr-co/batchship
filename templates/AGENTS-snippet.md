<!-- batchship:start -->
## Batch flow
Read BATCH.md before changing code. In short:
- Never edit or commit on the live branch (`protectedBranch` in `.ship.json`) or any `manualBranches` branch.
- Each fix: `node .batchship/fix.mjs start <name>` (joins today's batch), work in the printed worktree, then `node .batchship/fix.mjs done`. It checks, gets the agent review, and merges the fix PR into the batch. A separate batch needs a reason: `triage.mjs new <name> --reason "..."`.
- Ship a batch with `node .batchship/ship.mjs` (in the background): it opens one PR to the live branch as a draft. It merges it after CI (or queues it, when the repo uses Mergify) only when the user asked to ship in the session.
- Red CI or a whole-batch review blocker: repair it yourself (BATCH.md, "Red CI on a batch"); hand it to the human only when it is big (soloPaths, more than ~5 files or 200 lines, a migration, secret or CI change) or the tries run out.
- Never push to `ship/*` or the live branch directly, never mark PRs ready or merge them yourself (ship.mjs and fix.mjs do), never deploy. Exceptions only when the user asks in the session: a hotfix (`triage.mjs hotfix <name>`, a normal PR merged after CI), or to ship when their fixes are done (finish them all, then `ship.mjs --merge`).
<!-- batchship:end -->
