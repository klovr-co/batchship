---
name: ship
description: Ship PRs through the repo's merge queue with tug. Use when the user says ship, merge, go, make it live, all, everything, except #X, hold #X, now, asap, urgent, hotfix, or answers yes to a "Needs owner:" question, in a repo with .agents/config.yml.
---

# Shipping with tug

The repo's rules are the tug block in AGENTS.md; settings are in `.agents/config.yml`. The CLI is `tug`
(if it is not on PATH: `node <this plugin>/bin/tug.mjs`, two directories above this file).

## What the user said → what you run

The verb never matters ("ship", "merge", "go", "make it live", "pr and merge" all mean ship). The scope and timing words do.

| They said | You do |
|---|---|
| "ship it", "ship", "this", no scope | `tug ship <the PR you are discussing> --background` |
| "all", "everything", "them", "these" | `tug ship <n>` for every PR in **your last list to them**, never every open PR. Needs-owner PRs in that list are included: "all" is their yes, so first `gh pr edit <n> --remove-label needs-owner --add-label approved`. |
| "except #X", "not #X", "hold #X" | `gh pr edit X --add-label hold`, then ship the rest |
| "now", "asap", "urgent", "hotfix", "don't wait" | `tug ship --now <the one that matters most>`; the rest with plain `tug ship`. Tell them the rest follow in the next batch. |
| "yes" / "go" answering your Needs-owner question | `gh pr edit <n> --remove-label needs-owner --add-label approved`, then `tug ship <n>` |
| "wait", "not yet", "hold" | `gh pr edit <n> --add-label hold`; do not ship |

Don't ask before shipping. Ask only when the scope is ambiguous (two lists, no list); then ask once and say what you will do if they don't answer.

Run `tug ship <n> --background` in a background shell (your harness's background command, e.g. Claude Code's
`run_in_background`): it prints one line when it exits and you are woken then. Don't poll and don't sleep;
`tug ship --status <n>` prints the last state without waiting. Several PRs: start each in its own background shell,
close together, so Mergify tests them in one batch.
Without being asked, use `--now` only when the ship branch is red, your PR fixes it, and no other open PR has `hotfix`.

## Before `tug ship`
- The pre-push gate passed on your last push (never `--no-verify`).
- Another agent reviewed the diff (`git diff origin/<ship branch>...HEAD`); blockers and majors are fixed.
- UI changes: screenshots on the PR (`gh pr comment <n> --attach <image>`).
- Changes matching `needsOwner` in the config: the PR has `needs-owner` and a first line `Needs owner: <the decision>` until the user says yes. `tug ship` reads the PR's files itself, before every queue command and after every push, and refuses a match unless the PR has `approved`.

## Reading the result

`tug ship` prints one line, and on failure one `next:` line. Do what `next:` says.

| Exit | Meaning | You |
|---|---|---|
| 0 | merged, deploy done (or none configured) | open `liveUrl`, check the changed screens, report once with a screenshot |
| 2 | refused: `hold`, `needs-owner`, a needsOwner file without `approved`, closed, wrong base, or another PR has `hotfix` | follow `next:`; for needs-owner, ask the one question |
| 3 | out of the queue: red batch, conflict, or unmet conditions | fix, push (the gate runs), `tug ship <n>` again |
| 4 | merged but the deploy failed | open the run; fix forward with a new PR and ship it |
| 5 | timed out | open the PR's "Mergify Merge Queue" check; report once if you cannot move it |

On exits 2, 3 and 5 tug leaves nothing armed: it removes `queue`/`hotfix` and posts `@mergifyio dequeue` if the PR was queued; `next:` says what it undid. A deploy run that skipped every deploy job reports `deploy steps skipped (path-scoped)`: nothing was deployed, so say so.

CI runs on Mergify's batch draft, not on the PR, so `gh pr checks <n>` shows nothing: trust `tug ship`'s line.
Never end on "I'll check back": the turn-end guard (`tug guard`, installed by `tug setup`) stops a turn that leaves a
queued PR without a running `tug ship`, or that asks the user a question no `needs-owner` PR carries.
Report "not checked" for anything you did not see yourself (for example a deploy that printed `not run (not checked)`).
