<!-- tug:start v{{version}} -->
## Shipping (managed by tug; settings in .agents/config.yml)
1. Work in your own worktree from a fresh origin/{{shipBranch}}. Never push to it, merge by hand, or deploy by hand.
2. Before shipping: the pre-push check passes (never --no-verify), another agent has reviewed the diff, and UI changes have screenshots on the PR.
3. Ship with `tug ship <pr>`. Don't ask the user first. It queues, re-queues after pushes, waits for merge and deploy, and prints the result. Then check the live URL and report once, with a screenshot.
4. Exception: anything matching `needsOwner` in the config gets the `needs-owner` label and a first line "Needs owner: <the decision>". Ship it when the user says yes (remove the label first).
5. The user's verb doesn't matter. "it" = this PR · "all" = your last list (needs-owner ones included: "all" is the yes) · "except #X"/"hold #X" = add `hold` to X · "now" = `tug ship --now` on the most important one.
6. UI change: write the acceptance rules in 2–3 lines first; ask only if the request can be read two ways.
7. Never claim what you didn't check; say "not checked". Report data work as N of M.
8. When you need the user: one question, with what you'll do if they don't answer. Don't repeat it.
<!-- tug:end -->
