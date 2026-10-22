<!-- batchship:start -->
## Batch flow
Read BATCH.md before changing code. In short:
- Never edit or commit on the live branch (`protectedBranch` in `.ship.json`) or any `manualBranches` branch.
- Each fix: `node .batchship/fix.mjs start <name>` (joins today's batch), work in the printed worktree, then `node .batchship/fix.mjs done`. It checks, gets the agent review, and merges the fix PR into the batch. A separate batch needs a reason: `triage.mjs new <name> --reason "..."`.
- Ship a batch with `node .batchship/ship.mjs`: it opens one PR to the live branch for the human.
- Never push to `ship/*` or the live branch directly, never mark PRs ready, never merge, never deploy. Exceptions only when the user asks in the session: a hotfix (`triage.mjs hotfix <name>`, a normal PR merged after CI), or to ship when their fixes are done (finish them all, then `ship.mjs --merge`).
<!-- batchship:end -->
