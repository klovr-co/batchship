---
name: ship-batch
description: One PR per fix, one CI run per batch. Use before changing code in a repo that has .ship.json (start a fix with fix.mjs), for /ship-batch setup|start|done|ship|hotfix|status, or before opening any PR to the protected branch.
---

Repo state lives in `.ship.json`, `BATCH.md` and `.batchship/`. If they are missing, run `init.mjs` from the repo root (it lives in the batchship plugin or clone: `scripts/init.mjs`; in Claude Code `${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs`), then `setup`. If a `.batchship/` script is missing, run the plugin's copy (`${CLAUDE_PLUGIN_ROOT}/scripts/<name>`).

## setup
Review the draft checks in `.ship.json` (init filled them from `node .batchship/detect.mjs`).
1. Read `.github/workflows/*.yml`, `package.json`, `Makefile`, `pyproject.toml`. Use only commands the repo already runs; never invent one. Copy `cmd` verbatim from CI where it exists.
2. Keep only fast checks (lint, typecheck, unit tests). Drop browser/e2e suites, anything needing secrets or services, build and deploy steps.
3. `quick: true` only for checks that finish in about 30s. Set `cwd` and `paths` per folder for mixed-language repos.
4. Run each kept command once and time it. Drop or flag any that fail on a clean checkout or are slow (over ~2 min).
5. If `gh` works, rank by CI history (`gh run list`, failed jobs); keep checks that fail often.
6. Check that CI runs only on PRs to the live branch (`pull_request: branches: [<live>]`); otherwise fix PRs into `ship/*` cost CI. Say so; do not edit CI files.
7. Show the final `.ship.json` with a one-line reason per check and what was left out. Get user confirmation before writing. Keep `guardMode: "warn"`.
Stop and ask if there is no recognisable stack, no CI, several competing candidates, or a non-GitHub host.

## Commands
Follow BATCH.md; these are its steps.
- `start <name>` (or any coding task while on the live branch): `node .batchship/fix.mjs start <name>` joins today's batch; hand the fix to a worker with the worker prompt in BATCH.md. A separate batch only for soloPaths, a full batch, or the user asking: `triage.mjs new <name> --reason "..."`.
- `done`: in the fix worktree, `node .batchship/fix.mjs done --title "..."`. It checks, reviews, opens the fix PR into the batch and merges it. Fix what it reports and run it again.
- `ship [<batch>]`: `node .batchship/ship.mjs` opens the batch PR to the live branch as a draft. `--now` only when the user asked to ship now.
- `hotfix <name>`: only when the user asked for a hotfix: `node .batchship/triage.mjs hotfix <name>`, then a normal PR to the live branch, merged after its CI passes.
- `status`: `node .batchship/triage.mjs list`.

Never edit, commit or push on the live branch or a `manualBranches` branch, never push to `ship/*` directly, never mark ready or merge unless the user asked for a hotfix or to ship now.
