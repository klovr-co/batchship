<img src="assets/icon.svg" width="64" height="64" alt="">

# batchship

Pay for CI once per batch of fixes, not once per fix. Made for coding agents (Claude Code, delegated children, Codex) and the people who run them.

## Install

Once per machine (global):

    /plugin marketplace add <owner>/batchship
    /plugin install batchship@batchship

Once per repo (from the repo root):

    node <path-to-batchship>/scripts/init.mjs

`init` writes `.ship.json`, `BATCH.md`, a PR template line, three lines in `AGENTS.md`, and a git `pre-push` hook. It never overwrites existing files. Then edit `.ship.json` so `checks` match your CI jobs.

## What each layer covers

| Layer | Covers |
|---|---|
| Plugin hook (`hooks/hooks.json`) | Claude Code: blocks `gh pr create/ready` to `main` outside `ship/*` / `hotfix/*` or without a passing local check; blocks push to `main` |
| `/ship-batch` skill | start, check, open, close, status |
| `AGENTS.md` + `BATCH.md` prompt block | Other agents and delegated children |
| git `pre-push` hook | Any agent or human |

The hook starts in `warn` mode (`guardMode` in `.ship.json`); switch to `block` after a week.

## Test

    node --test 'scripts/tests/*.test.mjs'

Not built yet: release-gate workflow, CI branch-name warning, `ci-health` report (see the spec).
