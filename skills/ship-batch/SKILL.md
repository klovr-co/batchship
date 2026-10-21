---
name: ship-batch
description: Batch many fixes into one PR and one CI run. Use for /ship-batch setup|start|check|open|close|status, or before opening any PR to the protected branch.
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
- `start <area>`: `git fetch origin`, branch `ship/<owner>-<area>` from `origin/<protectedBranch>`, push with `-u`, add a row to the BATCH.md table (today's date).
- `check [--quick]`: run `node .batchship/batch-check.mjs`. Fix failures locally. Do not open a PR until the full check passes on HEAD.
- `open`: full check, then `gh pr create --draft --base <protectedBranch>`. Stop there and tell the user the PR is a draft. Never run `gh pr ready` or `gh pr merge`: marking ready starts the paid CI run and merging is the human's call.
- `close`: remove the table row; record evidence (what was fixed, screenshot or test proof) in the repo's notes file.
- `status`: list table rows whose branch has had no push for 3+ days.

Never push to the protected branch. Never open a PR to it from a branch that is not `ship/*` or `hotfix/*`. Delegated children follow the prompt block in BATCH.md.
