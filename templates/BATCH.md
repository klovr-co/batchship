# Batch flow

Pay for CI once per batch, not once per fix. A batch is a temporary integration branch `ship/<name>-<YYYYMMDD>`: fixes pile up on it with no CI, then the human marks its draft PR ready (one CI run) and merges it into the live branch (`protectedBranch` in `.ship.json`).

## 1. Triage (the thread on the live branch)
Never edit or commit on the live branch. For each task:
1. `node .batchship/triage.mjs list` shows the open batches: age, PR, commits, files, and whether each can be joined.
2. Decide. Join an open batch if the change is related: a reviewer would read them together, you would revert them together. Otherwise, or if it is risky, start a new one named after the feature or problem.
3. `node .batchship/triage.mjs join <batch>` or `node .batchship/triage.mjs new <name>`. It prints the worktree, with dependencies installed.
4. Tell the user the grouping in one line, e.g. `A+B -> ship/checkout-flow-20261022, C -> new ship/onboarding-copy-20261022`, and carry on.

The script refuses to join a batch that is older than `batchMaxAgeDays`, marked ready, merged, mid-edit by another worker, or holding `soloPaths` changes. Changes that touch `soloPaths` go in a new batch of their own.

## 2. Hand off: one worker per batch
Tasks for the same batch go to the same worker, one after another. Different batches run in parallel.
- T3: launch a thread with `workspaceStrategy: {"type":"existing_worktree","worktreePath":"<worktree>","branch":"<batch>"}` and the worker prompt.
- Claude Code without T3: a subagent with the worker prompt.
- On your own: work in the worktree yourself.

Already working on your own branch (e.g. a T3 thread's worktree)? `node .batchship/triage.mjs adopt <name>` turns that branch into a batch in place.

## 3. Worker prompt
> Work only in `<worktree>` on branch `<batch>`. Commit each fix there; run `node .batchship/batch-check.mjs --quick` before each commit. When done: merge in the latest live branch (`git fetch origin && git merge origin/<live>`), run `node .batchship/batch-check.mjs`, push, and open or update the draft PR (`gh pr create --draft --base <live>`, titled after the batch). Never mark it ready, never merge, never push to the live or manual branches, never deploy.

## 4. Human
Mark the draft ready when the batch is done (CI runs once), then merge. `triage.mjs list` flags stale batches: close or abandon them.

Urgent production bug: a `hotfix/NAME` PR to the live branch.
