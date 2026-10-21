<img src="assets/icon.svg" width="64" height="64" alt="">

# batchship

Pay for CI once per batch of fixes, not once per fix. Made for coding agents (Claude Code, delegated children, Codex) and the people who run them.

## Install

Once per machine (global):

    /plugin marketplace add klovr-co/batchship
    /plugin install batchship@batchship

Once per repo (from the repo root):

    node <path-to-batchship>/scripts/init.mjs

`init` writes `.ship.json`, `BATCH.md`, a PR template line, three lines in `AGENTS.md`, and a git `pre-push` hook. It never overwrites existing files. Then edit `.ship.json` so `checks` match your CI jobs.

## How it works

```mermaid
flowchart TD
  subgraph Setup["Once per repo"]
    I["init.mjs: .ship.json, BATCH.md, AGENTS.md, pre-push hook"] --> S["/ship-batch setup: agent reviews draft checks, you confirm"]
  end

  subgraph Build["Build: free, no CI"]
    A["/ship-batch start AREA: branch ship/NAME from main"] --> B["Agents fix, one worktree per bug"]
    B --> C{"batch-check --quick passes?"}
    C -- "no" --> B
    C -- "yes" --> D["Merge into batch, push"]
    D --> E{"More fixes?"}
    E -- "yes" --> B
    E -- "no" --> F["Full batch-check on whole batch"]
    F -- "fail" --> B
  end

  subgraph Pay["Paid once per batch"]
    F -- "pass: marker written for HEAD" --> G["/ship-batch open: draft PR to main"]
    G --> H["Mark ready: CI runs once"]
    H -- "red" --> B
    H -- "green" --> M["Merge, deploy, verify"]
  end

  S --> A
  M --> Z["/ship-batch close: remove row, log evidence"]
  U["Urgent bug"] -.-> HF["hotfix/NAME PR to main"] -.-> H

  X["Guard: PR to main from other branch, no marker, or push to main"] -. "warn, then block" .-> G
```

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
