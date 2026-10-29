<img src="assets/icon.svg" width="64" height="64" alt="">

# tug

tug gives every repo the same agent delivery flow: an agent works in its own worktree, a pre-push gate runs the
cheap checks on its machine, and `tug ship <pr>` hands the PR to a Mergify merge queue that tests queued PRs
together in one CI run (ordinary PRs run no CI). tug then stays with the PR (it queues it again after a push) until it is
merged and deployed, and prints one line: the merged sha, the deploy status and the live URL, or what failed and the one
next step. A short block in AGENTS.md tells agents the rules; `.agents/config.yml` holds the settings. Node ESM,
zero dependencies, MIT.

Nobody has to ask "status?" or "is it live?" (1.1): GitHub comments on each PR when it deploys (or fails, or every
deploy job was skipped), assigns `needs-owner` PRs to the owners, and opens one "Live branch is red" issue; agents run
`tug ship --background` and are woken when it exits; and `tug guard`, a turn-end hook, keeps an agent from ending a
turn with a queued PR nobody follows or a question no `needs-owner` PR carries.

## Install

    git clone https://github.com/klovr-co/batchship tug && cd tug && npm link    # puts `tug` on PATH

As an agent plugin (for the `adopt` and `ship` skills): Claude Code `/plugin marketplace add klovr-co/batchship`
then `/plugin install tug@tug`; Codex `codex plugin marketplace add klovr-co/batchship` then `codex plugin add tug@tug`.

## Commands

| Command | What it does |
|---|---|
| `tug init [--dry-run] [--force]` | Once per repo. Reads the ship branch from origin and opens **one PR** (labelled `needs-owner`) with `.agents/config.yml` (missing keys added, yours kept), the AGENTS.md block (only between `<!-- tug:start vX -->` and `<!-- tug:end -->`), the gate in `.agents/tug/`, the pre-push hook (in the repo's hook manager if it has one, else `.githooks/pre-push`), `.mergify.yml` and `.agents/tug.lock`. Creates the labels `queue`, `hotfix`, `hold`, `needs-owner`, `approved`, `full-ci`, and sets the default branch to `branches[shipTarget]` (Mergify reads its config there). Also adds `.agents/state/` to `.gitignore`, and opens a **second PR** (also `needs-owner`, since it changes `.github/`) with `.github/workflows/tug-events.yml`, rendered from the config (see Events). Keeps a repo's own `.mergify.yml` or hook and says what to change; `--force` replaces them. `--dry-run` prints the plan. |
| `tug setup` | Once per machine per repo. Turns the gate on: `core.hooksPath .githooks` when there is no hook manager; with lefthook or husky it never sets it, and unsets a stale `.githooks` that would switch them off. Adds `gh needs-me` (open PRs labelled needs-owner or hold), registers the repo in `~/.config/tug/repos`, checks gh auth, node and the package manager against the repo's pin, and prints the T3 settings to apply (worktree per thread; a setup script that installs dependencies, e.g. `bunx bun@$(cat .bun-version) install --frozen-lockfile`). Installs the turn-end guard as a Stop hook for each harness it finds (`~/.claude/settings.json`, `~/.codex/hooks.json`; `CLAUDE_CONFIG_DIR`/`CODEX_HOME` respected), merging into the file and reading it back; existing hooks are kept. |
| `tug ship <pr> [--now] [--background]` · `tug ship --status <pr>` | Refuses `needs-owner` and `hold`, and a PR whose changed files match `needsOwner.paths` unless it has `approved` (checked again after every push). Checks `deployWorkflows` against `.github/workflows/` first. Marks a draft ready, adds `queue` (and `hotfix` with `--now`, refused if another open PR has it), posts a comment that is exactly `@mergifyio queue` (the label alone does not queue), polls the Mergify check until queued, re-posts after a push only once Mergify has registered it, waits for the merge, then for `deployWorkflows` on the merge commit. On 2, 3 and 5 it removes `queue`/`hotfix` and posts `@mergifyio dequeue` if it was queued. Waits out GitHub rate limits (at most 15 min at a time). A deploy whose jobs were all skipped by path filters is reported as such, not as deployed. Exit 0 merged and deployed · 2 refused · 3 out of the queue · 4 deploy failed · 5 timed out · 1 error. Every run keeps its progress, a heartbeat and its result in `.agents/state/ship-<pr>.json` and records the PR for the agent's session (`TUG_SESSION_ID`, `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`). `--background` prints nothing until the end, then one line (`<result> · next: <step>`): start it in a background shell and you are woken when it exits. `--status` prints the last state without waiting. |
| `tug doctor` | Reports, changes nothing: labels, default branch = ship branch, the pre-push hook really runs here (and through which mechanism), AGENTS block and lock versions = kit version, every queue rule blocks `hold` and `needs-owner`, the events workflow matches the config, `owners` is set, the guard hook is installed in each harness found and fires (a probe run), root checkout behind origin. |
| `tug guard [--hook claude\|codex]` | The turn-end check. Blocks when (a) a PR this session queued is neither merged and deployed nor followed by a live `tug ship` (pid and heartbeat in its state file), or (b) the last assistant message asks a question and no open PR from this session has `needs-owner`. Plain: exits 1 with one reason line. `--hook`: reads the Stop hook payload (session id, `last_assistant_message` or the transcript) and prints `{"decision":"block","reason":...}`; at most 2 blocks per turn, each reason once, and any error lets the turn end. Does nothing outside a repo with `.agents/config.yml`. Codex runs a new hook only after you trust it (`/hooks`). |
| `tug upkeep [--dry-run]` | Daily, over the registered repos (macOS and Linux): fast-forwards each root checkout to origin/&lt;ship branch&gt;, removes worktrees whose PR is merged or closed, that are clean, whose every commit is in a pushed PR head, and that have been idle 2+ days (never `--force`), then runs doctor. |

The pre-push gate (`node .agents/tug/pre-push.mjs`, run by the hook) checks every pushed commit except tags and
deletes, `git push origin HEAD:branch` included: no changed file may flip CRLF/LF or become mixed; each `generated`
command must leave the tree unchanged; then `checkCommand` runs. In a fresh worktree without `node_modules` it says which install command to run.

## Settings (`.agents/config.yml`)

`shipTarget` (production | staging) · `branches: {production, staging}` · `needsOwner: {paths, categories}` ·
`checkCommand` · `installCommand` · `generated: [{run}]` · `deployWorkflows` · `liveUrl` · `mergeMethod`
(squash | merge | rebase) · `ciCheck` (the gate job's name, which the queue waits for) · `owners` (GitHub logins: assigned
`needs-owner` PRs and the red-live-branch issue).

## Events (`.github/workflows/tug-events.yml`)

Built-in `GITHUB_TOKEN`, `permissions: {}` at the top and the least per job, `ubuntu-slim`, `timeout-minutes: 2`,
`actions/github-script` pinned by SHA and nothing else. The scripts read titles, bodies and branch names from the event
payload and only send them back through the API; config values reach them as quoted env values (a value containing
`${{` is refused).
- `pull_request_target` labeled `needs-owner`: assign `owners`, comment "Needs your decision: <first line of the body>"; `hold`: "On hold. Say ship to release it."
- `workflow_run` of each `deployWorkflows` file (matched by its `name:`) on the ship branch: "Deployed ✓ <sha> → <liveUrl>", "Not deployed: every deploy job was skipped…", or "Deploy failed: <run url>", on the PR of that commit.
- `workflow_run` of the CI workflow (the one with a job named `ciCheck`) failing on the ship branch: opens or updates one issue "Live branch is red" assigned to `owners`; closes it when the branch is green again. Only fires when that workflow runs on pushes to the ship branch.

## Skills

- `adopt`: after `tug init`, fit the CI gate (`templates/ci/gate.snippet.yml`) into the repo's existing workflow as its own PR, write its `checkCommand`, wire the gate into its hook manager, or propose `templates/ci/starter-pnpm.yml` / `starter-bun.yml` when it has no CI.
- `ship`: what to run when the user says ship, all, except #X, hold #X or now.

## Development

    npm test    # node --test; tests that use git make their own repo under the OS temp dir; no network

tug replaces batchship (batch branches, `fix`/`ship`/`triage` scripts, BATCH.md, `.ship.json`, phrase-enforcing hooks),
retired on 22 Oct 2026 for the Mergify queue. That code is in this repo's history.
