---
name: adopt
description: Fit a repo to tug after `tug init` - put the CI gate into its existing workflow as its own PR, write the repo's pre-push checkCommand, wire the gate into its hook manager, and propose starter CI when it has none. Use when the user says adopt tug, set up tug, or when `tug init`/`tug doctor` reports a missing gate, checkCommand or hook.
---

# Adopting tug in a repo

`tug init` writes what it can safely write (one PR, labelled needs-owner). This skill does the parts that need
judgment, each as its own small PR with `needs-owner` (they change `.github/` or hook config). Run
`tug init --dry-run` and `tug doctor` first; their "left" and "Note:" lines are your task list.
Templates live in this plugin's `templates/` (two directories above this file).

## 1. The CI gate (its own PR)

Goal: an ordinary PR runs **no** CI; only Mergify's batch drafts (`mergify/merge-queue/*`) and manual runs do,
and one gate job is the check the queue waits for. Follow `templates/ci/gate.snippet.yml`:

1. Read every workflow in `.github/workflows/` that runs on `pull_request`. Keep the trigger (Mergify's drafts are PRs into the ship branch); add `workflow_dispatch`.
2. Add the snippet's `if:` to every job with no `needs:`. Keep any existing condition with `&&`. If the repo also has a manual promotion PR (for example staging -> main), keep it running too, as aldrent does: `(github.base_ref == 'main' && !github.event.pull_request.draft) || ...`.
3. Add the gate job (`name:` = `ciCheck` in `.agents/config.yml`; if the repo already has an aggregate job, such as "CI result" or "Lint + Typecheck + Build", reuse it and set `ciCheck` to its name instead). Its `needs:` lists every other job.
4. Path-scoped CI: add the `full-ci` step (python3 -I, no gh CLI: self-hosted runners may lack it).
5. A new top-level file the CI scope script does not know can trigger a full run: keep kit files under `.agents/` and `.githooks/`, and teach the scope script that those paths need no app checks.
6. Prove it on the PR: a `Proof:` line saying the PR itself ran no jobs (`gh pr checks <n>` is empty) and why the queue draft will run them.

No CI at all: propose `templates/ci/starter-pnpm.yml` or `starter-bun.yml` (pick by lockfile), trimmed to the scripts `package.json` really has. Do not invent scripts.

## 2. checkCommand (in the gate PR or alone)

The pre-push gate already checks line endings and `generated` outputs. `checkCommand` adds the repo's own cheap checks:
- Prefer a script the repo already has (3ven: `node scripts/check-before-push.mjs --hook`; aldrent: `node scripts/pre-push-check.mjs` with `PRE_PUSH_STDIN=1`). The hook's stdin is passed through to it.
- Otherwise compose it from CI's cheapest jobs: lint, typecheck scoped to what changed, fast unit tests. Under ~2 minutes; no network, no secrets.
- Committed generated files (API references, schema types): add each generator under `generated:` with `run:`.
- Set `installCommand` only if detection is wrong (`tug setup` prints what it detected).

## 3. Hook wiring

- No hook manager: `tug init` wrote `.githooks/pre-push`; each machine runs `tug setup`.
- lefthook with its own `pre-push:` section: add a job `run: node .agents/tug/pre-push.mjs --hook` with `use_stdin: true`. If the existing job already runs the same checks, point `checkCommand` at that script and drop the duplicate job, so a push runs them once. Never set `core.hooksPath` in a lefthook or husky repo: it turns their hooks off.
- husky / simple-git-hooks / pre-commit: add the line `tug init` printed.
- A repo's own `.githooks/pre-push`: move its command into `checkCommand`, then `tug init --force` replaces the hook with tug's.

## 4. The repo's own .mergify.yml

`tug init` keeps it and names each queue rule that lets `hold` or `needs-owner` in. Either add `-label = hold` and `-label = needs-owner` to each rule's `queue_conditions` (top level, not inside `or:`), or replace the file with tug's (`tug init --force`) after checking what the repo's version does that tug's does not (retry gates, `approved` rules) and carrying that over in the config.

## 5. AGENTS.md

`tug init` added the tug block and left the rest. Old sections that repeat or contradict it ("Merging: the merge queue", "Ship target") can go in the same PR as the block, with the owner's yes; keep repo-specific facts (deploy workflows, proof rules) by moving them into `.agents/config.yml` or a short line under the block.

Finish with `tug doctor`: every line `ok`, or a sentence in the PR on why not.
