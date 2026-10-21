<!-- batchship:start -->
## Batch flow
Read BATCH.md before changing code. In short:
- Never edit or commit on the live branch (`protectedBranch` in `.ship.json`) or any `manualBranches` branch. Triage first: `node .batchship/triage.mjs list`, then `join <batch>` or `new <name>`, and work only in the printed worktree.
- You decide which batch a change belongs in: join an open batch when a reviewer would read the changes together; otherwise start a new one named after the feature or problem.
- Open PRs as drafts only. Never mark a PR ready, never merge, never push to the live or manual branches, never deploy. Run `node .batchship/batch-check.mjs` before opening or updating a PR.
<!-- batchship:end -->
