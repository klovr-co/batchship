<img src="assets/icon.svg" width="64" height="64" alt="">

# batchship

Pay for CI once per batch of fixes, not once per fix. Made for coding agents (Claude Code, T3, Codex, Antigravity) and the people who run them.

## Install

Pick your agent, then run `init` once per repo (all agents):

| Agent | Install the plugin (skill) |
|---|---|
| Claude Code | `/plugin marketplace add klovr-co/batchship` then `/plugin install batchship@batchship` |
| Codex | `codex plugin marketplace add klovr-co/batchship` then `codex plugin add batchship@batchship` |
| Antigravity (agy) | `agy plugin install https://github.com/klovr-co/batchship` |

Per repo, from the repo root (needs Node and a clone of this repo, or the installed plugin directory):

    node <path-to-batchship>/scripts/init.mjs

For a repo where `staging` is live and `main` is only touched by a human: `init --protected staging --manual main`.

`init` writes `.batchship/` (the scripts), `.ship.json`, `BATCH.md`, a PR template, a batch section in `AGENTS.md` (and `@AGENTS.md` in `CLAUDE.md`, since Claude Code reads only that), a git `pre-push` hook, and per-agent hook files: `.agents/hooks.json` (Antigravity) and `.codex/hooks.json` (Codex); the Claude Code hook ships in the plugin. It never overwrites existing files. Then run `/ship-batch setup` or edit `.ship.json` so `checks` match your CI jobs.

Already set up, new plugin version: `init --update` refreshes `.batchship/`, `BATCH.md` and the `AGENTS.md` section, and keeps `.ship.json`. Until then, the guard points at the plugin's own scripts and says the repo's copy is behind.

CI must run only on PRs to the live branch (`pull_request: branches: [main]`), or fix PRs into `ship/*` will cost CI; `fix.mjs done` warns when it does not.

## How it works

One PR per fix, one CI run per batch. A batch is a temporary integration branch: today's is `ship/day-<YYYYMMDD>`. Each fix gets its own branch and PR into the batch, reviewed by agents, with no CI (CI runs only on PRs to the live branch). When the batch ships, one PR goes to the live branch and CI runs once. Fixes join today's batch unless there is a stated reason not to.

```mermaid
flowchart TD
    subgraph HOME["Your thread on the live branch: hands out fixes, never edits"]
        T["Tasks"] --> R{"Reason for a separate batch?<br/>soloPaths · batch full · you asked"}
        R -- "no (default)" --> TB["Today's batch ship/day-YYYYMMDD"]
        R -- "yes: triage new NAME --reason" --> SB["Separate batch ship/NAME-YYYYMMDD"]
    end
    TB --> FS
    SB --> FS
    subgraph W["Workers: several per batch, one reused worktree each"]
        FS["fix start NAME: branch fix/NAME from the batch"] --> C["Code, quick check, commit"]
        C --> FD["fix done: full check + agent review"]
        FD -- "findings" --> C
        FD -- "passed" --> PR["Fix PR into the batch, review posted on it, squash-merged<br/>no CI on PRs into ship/*"]
    end
    PR --> SH["ship: merge live in, full check, advisory review of the whole batch<br/>batch PR to live (draft) listing every fix PR"]
    SH --> A{"review.after, or you said 'ship when done'"}
    A -- "merge (default) / ship when done" --> AU["ship.mjs marks ready, ONE CI run, merges with a merge commit<br/>stays draft if the batch review finds a blocker"]
    A -- "human" --> Y["You mark ready: ONE CI run, merge with a merge commit"]
    HF["User says 'hotfix': hotfix/NAME, normal PR to live, merge after CI"] -.-> LIVE["live branch, deploy"]
    Y --> LIVE
    AU --> LIVE
```

### With the Mergify merge queue

If the repo has `.mergify.yml` (or `mergeVia: "mergify"`), ship.mjs does not merge the batch PR itself. It marks it ready and comments `@mergifyio queue`. Mergify brings the batch up to date with the live branch when it moved (a merge commit, so `ship/*` history is never rewritten), waits for CI and merges it. A PR Mergify takes out of the queue counts as red CI: the same repair loop runs. The guard denies `gh pr merge` to agents in such a repo; a hotfix is queued with `@mergifyio queue` too. Use `merge_method: merge` in the queue rule so each fix stays its own commit for `git bisect`, and queue `hotfix/*` ahead of `ship/*`:

```yaml
merge_queue: { max_parallel_checks: 1, mode: serial }   # checks run in place on the PR
queue_rules:
  - name: hotfix
    queue_conditions: [base = staging, head ~= ^hotfix/, -draft, check-success = CI]
    merge_conditions: [base = staging, head ~= ^hotfix/, -draft, check-success = CI]
    merge_method: merge
    update_method: merge
  - name: batches
    queue_conditions: [base = staging, head ~= ^ship/, -draft, check-success = CI]
    merge_conditions: [base = staging, head ~= ^ship/, -draft, check-success = CI]
    merge_method: merge
    update_method: merge
priority_rules:
  - { name: hotfix, conditions: [head ~= ^hotfix/], priority: high }
```

Mergify reads `.mergify.yml` from the repo's default branch.

### Red batch CI

Red batch CI: re-run only the failed jobs for runner or flaky failures; for a real failure, `git bisect run <test>` over the batch (one commit per fix) finds the fix, then repair it (`fix.mjs start <name> --repair`: reviewed like any fix, lands on the shipping batch) or `fix.mjs eject <PR>`, and ship again. ship.mjs stops after `review.ciRounds` red runs and hands it to you. A blocker from the whole-batch review is repaired the same way, `review.batchRepairRounds` times. The agent hands it to you at once when the repair would touch `soloPaths`, change more than about 5 files or 200 lines, need a migration, a secret or a CI change, or when the failure also happens on the live branch.

## Commands

| Command | Who | Does |
|---|---|---|
| `triage.mjs list` | Your thread | Batches, their fixes, and what shipping them costs |
| `fix.mjs start <name> [--batch B]` | Worker | Branch `fix/<name>` from today's batch (or B) in an idle worker worktree |
| `fix.mjs done [--title ..] [--focus ..]` | Worker | Full check, agent review, fix PR into the batch with the review on it, squash-merge |
| `fix.mjs adopt <name>` | Worker | Make the branch you are on a fix for today's batch |
| `triage.mjs new <name> --reason ".."` | Your thread | A separate batch, with the reason recorded in its PR |
| `ship.mjs [<batch>] [--merge]` | Your thread | The batch PR to the live branch; with `review.after: merge` (default) it marks it ready, waits for CI and merges. `--merge` (when you asked to ship) does so even under `human` |
| `fix.mjs eject <PR>` | Your thread | Revert one fix out of its batch |
| `triage.mjs hotfix <name>` | Your thread | `hotfix/<name>` from the live branch: a normal PR, merged after CI, when you asked for a hotfix |
| `triage.mjs prune [--apply]` | Your thread | Worktrees whose branch's PR merged, with nothing uncommitted or unpushed; `--apply` removes them |

Batches ship once a day by default. Two ways to go faster, in a Claude Code session:
- **Ship when done:** give your list and add "then ship when done" (or "ship after these", "ship it once they're finished"). Your thread finishes every fix, then ships the batch: ready, one CI run, merge.
- **Hotfix:** start a line with `hotfix: <what is broken>`. The agent makes a `hotfix/*` branch from the live branch, opens a normal PR, waits for CI and merges it, skipping the batch.

A prompt hook records the request for that session for two hours, and each one opens only its own path. Talking about it, asking a question about it, or quoting it does not count, and agents cannot unlock it themselves. The guard stops agents from taking these steps by mistake; it is not a security boundary.

## Settings (`.ship.json`)

| Key | Default | Meaning |
|---|---|---|
| `protectedBranch` | `main` | The live branch batches land on |
| `manualBranches` | `[]` | Human-only branches (e.g. `["main"]` when `staging` is live) |
| `guardMode` | `warn` | `block` makes the guard deny instead of warn |
| `checks` | detected | Fast local stand-ins for CI: `{ name, cmd, cwd?, paths?, quick? }` |
| `batchMaxAgeDays` | `0` | Days a batch takes new fixes; `0` = only the day it is dated (one batch per day) |
| `batchMaxFiles` | `40` | Changed files (lockfiles aside) at which a batch is full; `0` = no cap |
| `soloPaths` | `[]` | Path prefixes (e.g. `[".github/"]`) that must ship in a batch of their own |
| `setup` | auto | Command run in a new worker or hotfix worktree; default installs with the detected package manager |
| `mergeVia` | `auto` | Who merges a batch PR into the live branch: `gh` (ship.mjs), `mergify` (the Mergify queue), `auto` = `mergify` when the repo has `.mergify.yml` |
| `checks[].shipOnly` | `false` | Skip this check per fix (`fix.mjs done`); it runs once when the batch ships. For slow checks such as a whole-app typecheck |
| `review.reviewers` | `["same"]` | Agents that review each fix before it joins the batch, in parallel and read-only: `same` (the agent's own harness), `claude`, `codex`, `agy`, each optionally `:model`, or `{ "name", "cmd" }`. `[]` turns review off |
| `review.riskyReviewers` | `null` | Reviewers for a risky fix (touches `soloPaths` or `review.riskyPaths`, or more than `review.riskyLines` changed lines); `null` = `reviewers`. Lets small fixes use one reviewer and risky ones two |
| `review.riskyPaths` | `[]` | Extra path prefixes that make a fix risky |
| `review.riskyLines` | `400` | Changed lines above which a fix is risky; `0` = size never does |
| `review.rounds` | `2` | Failed reviews in a row before the fix goes back to you |
| `review.after` | `merge` | `merge`: when you asked to ship (or run it yourself), ship.mjs marks the batch PR ready, waits for CI and merges it, unless the whole-batch review finds a blocker or major issue. `human`: the batch PR waits for you. Read from the live branch, so a batch cannot change it |
| `review.focus` | `""` | Extra review instructions for every fix |
| `review.timeoutMinutes` | `20` | Per reviewer |
| `review.ciRounds` | `3` | Red CI runs on a batch PR before ship.mjs stops and hands it to you |
| `review.batchRepairRounds` | `1` | Times a blocker from the whole-batch review goes to a repair fix before the batch PR waits for you |
| `review.queueTimeoutMinutes` | `120` | With Mergify: how long ship.mjs waits for the queue |

## What each layer covers

| Layer | Covers |
|---|---|
| Plugin hooks (`hooks/hooks.json`) | Claude Code (tested): denies file edits and commits on the live or manual branches, pushes to them or straight to `ship/*`, `gh pr ready` / `gh pr merge` and non-draft PRs to the live branch (unless you asked for a hotfix or to ship in the session), and a batch PR without a passing local check. Records a hotfix or ship request from your prompt. Silent in repos without `.ship.json`; tells a repo when its scripts are older than the plugin |
| `.agents/hooks.json` | Antigravity: same guard for shell commands, agy hook protocol (unit-tested; not run inside agy). File edits are not seen |
| `.codex/hooks.json` | Codex: same guard. **Did not fire in a live test**; rely on `AGENTS.md` and `pre-push` |
| `.github/workflows/batch-branch-check.yml` | GitHub, any agent or person: flags a ready PR to the live branch whose head is not `ship/*` or `hotfix/*`. Starts as a warning; set `SHIP_ENFORCE` to `"1"` to fail it |
| `/ship-batch` skill, `AGENTS.md`, `BATCH.md` | The hand-off, worker and shipping steps, for every agent |
| `batch-check` | Local checks, plus the `soloPaths` rule |
| `fix.mjs`, `ship.mjs` | The steps that matter run as scripts: check, review, fix PR, merge into the batch, batch PR |
| `review.mjs` | Agent code review of each fix, and an advisory review of the whole batch |
| git `pre-push` hook | Any agent or human |

The hook starts in `warn` mode; switch to `block` once you trust it.

## Try it

    playground/setup.sh            # throwaway repo in /tmp with a local origin, guard on block
    cd /tmp/batchship-playground/app && claude

Give it a few fixes from `main` and watch it start fixes, review them and merge them into today's batch. With no GitHub remote, fixes merge into the batch locally instead of through PRs.

## Test

    node --test 'scripts/tests/*.test.mjs'

Not built yet: release-gate workflow and the `ci-health` report (see the spec).
