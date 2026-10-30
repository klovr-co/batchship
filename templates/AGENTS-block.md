<!-- tug:start v{{version}} -->
## Shipping (managed by tug; settings in .agents/config.yml)
{{hookLine}}
1. Work in your own worktree from a fresh origin/{{shipBranch}}. Never push to it, merge by hand, or deploy by hand.
2. Before shipping: the pre-push check passes (never --no-verify), another agent has reviewed the diff, and UI changes have screenshots on the PR.
3. Ship with `node .agents/tug/tug.mjs ship <pr> --background` in a background shell (an installed `tug ship` is the same; "tug ship" in its messages means either). Don't ask the user first. It queues, re-queues after pushes, waits for merge and deploy, and prints one result line when it exits. Then check the live URL and report once, with a screenshot.
4. Exception: anything matching `needsOwner` in the config gets the `needs-owner` label and a first line "Needs owner: <the decision>". When the user says yes, remove `needs-owner`, add `approved` (tug ship refuses owner-only files without it), then ship.
5. The user's verb doesn't matter. "it" = this PR · "all" = your last list (needs-owner ones included: "all" is the yes) · "except #X"/"hold #X" = add `hold` to X · "now" = `ship --now` on the most important one.
6. UI change: write the acceptance rules in 2–3 lines first; ask only if the request can be read two ways.
7. Never claim what you didn't check; say "not checked". Report data work as N of M.
8. When you need the user: one question, with what you'll do if they don't answer. Don't repeat it. A decision on a PR goes on the PR too (`needs-owner`, first line "Needs owner: <the question>"): GitHub tells the owners. What waits for them: `gh needs-me` (after `tug setup`), or in a browser {{needsMeUrl}}
9. Wait with `ship --background`, never with a PR watch alone (T3's PR watch ends at merge without waking you). You are woken when it exits, so don't poll or sleep (`node .agents/tug/tug.mjs ship --status <pr>` shows progress).
<!-- tug:end -->
