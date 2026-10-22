# Batch flow

One PR per fix, one CI run per batch. A batch is a temporary integration branch: today's is `ship/day-<YYYYMMDD>`. Each fix gets its own branch and PR into the batch, reviewed by agents; no CI runs on PRs into `ship/*`. When the batch ships, one PR goes to the live branch (`protectedBranch` in `.ship.json`) and CI runs once.

## Your thread (on the live branch): hand out fixes
Never edit or commit on the live branch. For each task:
1. New work joins today's batch. Start a separate batch only for one of these reasons, and say which:
   it touches `soloPaths`; today's batch is full; the user asked for it.
   `node .batchship/triage.mjs new <name> --reason "..."`
2. Give each fix to a worker (T3 thread on its worktree, a subagent, or yourself) with the worker prompt below. Several workers can work on the same batch at once.
3. Tell the user in one line where each fix went.

`node .batchship/triage.mjs list` shows the batches, their fixes and what shipping them costs.

## Worker prompt
> `node .batchship/fix.mjs start <fix-name>` (add `--batch <batch>` for a separate batch). Work only in the worktree it prints. Commit there; run `node .batchship/batch-check.mjs --quick` before each commit. When the fix is ready: `node .batchship/fix.mjs done --title "<what it fixes>"` (add `--focus "..."` for the risky part). It runs the full check and the agent review, opens the fix PR into the batch, posts the review on it, and merges it into the batch when everything passes. If it stops, fix what it says, commit, and run `fix.mjs done` again. After `review.rounds` failed reviews, stop and report the open findings. Never push to `ship/*` or the live branch directly, never mark PRs ready, never merge them yourself, never deploy.

Already working on your own branch (e.g. a T3 thread's worktree)? `node .batchship/fix.mjs adopt <name>`, then `fix.mjs done`.

## Shipping a batch
`node .batchship/ship.mjs [<batch>]`: merges the live branch in, runs the full check and an advisory review of the whole batch (how fixes interact, merge resolutions), and opens the batch PR to the live branch as a draft, listing every fix PR. Open fix PRs still aimed at it move to today's batch.
- `review.after: "merge"` (default): when the user asked to ship in the session (or a human runs it), ship.mjs marks it ready, waits for the one CI run and merges it with a **merge commit**, so each fix stays its own commit on the live branch. It takes as long as CI: run it in the background. If the whole-batch review finds a blocker or major issue, it stays a draft for the human.
- `review.after: "human"`: the human marks it ready (CI runs once) and merges it.

Batches ship once a day by default. When the user asks to ship once their work is done ("... then ship when done"), finish every fix they gave in the session, check none is still open, then run `node .batchship/ship.mjs --merge` in the background: it opens the batch PR, marks it ready, waits for CI and merges it (`--merge` also overrides `review.after: "human"`). Fixes other sessions still have open move to the next batch.

## Red CI on a batch
1. A runner lost, a timeout, or a test that also fails on the live branch: re-run only the failed jobs (`gh run rerun <run> --failed`).
2. A real failure: run the failing test locally on the batch and find the fix with `git bisect run <test>` over the batch's commits (one commit per fix).
3. Fix forward: `node .batchship/fix.mjs start <name> --repair` (it lands on the shipping batch, not today's), then `fix.mjs done` as usual: checked and reviewed. Or take the fix out: `node .batchship/fix.mjs eject <PR number>`.
4. Run `ship.mjs` again (in the background): it waits for the new CI run and merges when green. After `review.ciRounds` red runs (default 3) it stops: hand it to the human with what failed.

## Hotfix (urgent production bug)
Only when the user asks for one (a line starting "hotfix: ..."): `node .batchship/triage.mjs hotfix <name>`, fix it in that worktree, push, open a normal PR to the live branch, wait for its CI, merge. This skips the batch. The guard allows marking ready and merging only in a session where the user asked for a hotfix.
