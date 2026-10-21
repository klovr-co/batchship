# Batch flow

Pay for CI once per batch, not once per fix.

1. Pick an area. Check the open-batches table below; join an owned area with the owner's OK, else create `ship/OWNER-AREA` and add a row.
2. Build on the batch branch (free: nothing runs on `ship/*`). One worktree per fix, small commits, quick check before merging into the batch.
3. When done, run the full batch check. The agent opens a draft PR to the live branch and stops. The human marks it ready (CI runs once, the paid step) and merges.
4. Merge, verify on production, log evidence, remove the row.
5. Urgent production bug: `hotfix/NAME` PR to `main`.

A batch with no push for 3 days: close or abandon, remove the row.

## Delegated agent prompt (copy into delegate_task)
> Work only on branch `ship/NAME`. Open PRs as drafts only. Never mark ready, never merge, never push to the live branch or any `manualBranches` branch, never deploy. Run `node .batchship/batch-check.mjs --quick` before each commit to the batch.

## Open batches
| Owner | Area | Branch | Started | Status |
|---|---|---|---|---|
