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
> Work only in `<worktree>` on branch `<batch>`. For each fix: run `node .batchship/batch-check.mjs --quick`, commit, then `node .batchship/review.mjs` (add `--focus "..."` for the risky part). Fix blocker and major findings, commit, and review again; push only after the review passes. When the batch is done: merge in the latest live branch (`git fetch origin && git merge origin/<live>`), run `node .batchship/batch-check.mjs` and `node .batchship/review.mjs` again, push, and open or update the draft PR (`gh pr create --draft --base <live>`, titled after the batch). Never push to the live or manual branches, never deploy. Unless `review.after` is `merge`, never mark the PR ready and never merge. Report the PR, the review results and any findings left open.

## 4. Review each fix, then ship
Every fix is reviewed as it lands on the batch, before it is pushed, so nothing unreviewed reaches `ship/*` and each review sees a small change. `review.mjs` shows the reviewers only the commits since the last passing review; commits that just merge the live branch in pass without one. The guard refuses `git push` on a batch branch until HEAD has passed.

Reviewers come from `review.reviewers` in `.ship.json` and run in parallel, read-only: `"same"` (the agent's own harness, the default), `"claude"`, `"codex"`, `"agy"`, each optionally with `:model`, e.g. `["claude:claude-sonnet-5-5", "codex:gpt-6-sol"]`. Any blocker or major finding holds the fix; minors are only reported. After `review.rounds` failed reviews in a row, stop and hand the batch to the human with the open findings (`--force` re-opens review once the human says so).

When the batch is done:
- `review.after: "human"` (default): the worker stops at the draft PR. The human marks it ready (CI runs once) and merges.
- `review.after: "merge"`: with check and review passed for HEAD, the worker marks the PR ready from the worktree (`gh pr ready`), waits for CI (`gh pr checks --watch`), and merges (`gh pr merge --squash`) only if CI is green and no deploy of the live branch is running. If CI fails, fix it, check, review, push and retry. The guard refuses ready and merge without a passing check and review for HEAD.

`triage.mjs list` flags stale batches: close or abandon them.

Urgent production bug: a `hotfix/NAME` PR to the live branch (no review step).
