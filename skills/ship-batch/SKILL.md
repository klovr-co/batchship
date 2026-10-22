---
name: ship-batch
description: Batch many fixes into one PR and one CI run. Use before changing code in a repo that has .ship.json (triage the work into a batch first), for /ship-batch setup|start|adopt|check|open|review|status, or before opening any PR to the protected branch.
---

Repo state lives in `.ship.json`, `BATCH.md` and `.batchship/`. If they are missing, run `init.mjs` from the repo root (it lives in the batchship plugin or clone: `scripts/init.mjs`; in Claude Code `${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs`), then `setup`.

## setup
Review the draft checks in `.ship.json` (init filled them from `node .batchship/detect.mjs`).
1. Read `.github/workflows/*.yml`, `package.json`, `Makefile`, `pyproject.toml`. Use only commands the repo already runs; never invent one. Copy `cmd` verbatim from CI where it exists.
2. Keep only fast checks (lint, typecheck, unit tests). Drop browser/e2e suites, anything needing secrets or services, build and deploy steps.
3. `quick: true` only for checks that finish in about 30s. Set `cwd` and `paths` per folder for mixed-language repos.
4. Run each kept command once and time it. Drop or flag any that fail on a clean checkout or are slow (over ~2 min).
5. If `gh` works, rank by CI history (`gh run list`, failed jobs); keep checks that fail often.
6. Show the final `.ship.json` with a one-line reason per check and what was left out. Get user confirmation before writing. Keep `guardMode: "warn"`.
Stop and ask if there is no recognisable stack, no CI, several competing candidates, or a non-GitHub host. Do not edit CI files.

## Commands
Follow BATCH.md; these are its steps.
- `start` (or any coding task while on the live branch): triage. `node .batchship/triage.mjs list`, decide join or new yourself (related changes together, unrelated or risky apart, name it after the feature), then `join <batch>` or `new <name>`. Tell the user the grouping in one line, then hand each batch to one worker in its worktree (T3 thread on `existing_worktree`, else a subagent, else yourself) with the worker prompt in BATCH.md.
- `adopt <name>`: already working on a non-batch branch (e.g. a T3 thread's own worktree): `node .batchship/triage.mjs adopt <name>`.
- `check [--quick]`: run `node .batchship/batch-check.mjs`. Fix failures locally. Do not open a PR until the full check passes on HEAD.
- `review [--focus "..."]`: after each fix is committed, before pushing: `node .batchship/review.mjs` reviews the commits since the last passing review with the reviewers in `review.reviewers` (default `same`: your own harness). Fix blocker/major findings, commit, re-run. Push only once it passes. After `review.rounds` failures in a row, stop and hand over to the user.
- `open`: merge in the latest live branch, full check, review, push, then `gh pr create --draft --base <protectedBranch>`. Then follow `review.after`: `human` (default) stops at the draft and reports; `merge` marks ready, waits for CI, merges if green (BATCH.md step 4). Never run `gh pr ready` or `gh pr merge` otherwise.
- `status`: `node .batchship/triage.mjs list`; point out stale batches for the user to close or abandon.

Never edit, commit or push on the live branch or a `manualBranches` branch. Never open a PR to the live branch from a branch that is not `ship/*` or `hotfix/*`.
