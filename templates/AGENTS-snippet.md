<!-- batchship:start -->
## Batch flow
Read BATCH.md before changing code. In short:
- Never edit or commit on the live branch (`protectedBranch` in `.ship.json`) or any `manualBranches` branch. Triage first: `node .batchship/triage.mjs list`, then `join <batch>` or `new <name>`, and work only in the printed worktree.
- You decide which batch a change belongs in: join an open batch when a reviewer would read the changes together; otherwise start a new one named after the feature or problem.
- After each fix: commit, run `node .batchship/review.mjs`, fix blocker/major findings, and push only once it passes. Open PRs as drafts only, after a full `node .batchship/batch-check.mjs`.
- Never push to the live or manual branches, never deploy. Never mark a PR ready or merge it, unless `review.after` is `merge` in `.ship.json` and check and review both passed for HEAD (BATCH.md, step 4).
<!-- batchship:end -->
