---
name: ship-batch
description: Batch many fixes into one PR and one CI run. Use for /ship-batch start|check|open|close|status, or before opening any PR to the protected branch.
---

Read `.ship.json` and `BATCH.md` in the repo first. If missing, run `node ${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs`.

Commands:
- `start <area>`: `git fetch origin`, branch `ship/<owner>-<area>` from `origin/<protectedBranch>`, push with `-u`, add a row to the BATCH.md table (date today).
- `check [--quick]`: run `node ${CLAUDE_PLUGIN_ROOT}/scripts/batch-check.mjs`. Fix failures locally; never open a PR until the full check passes on HEAD.
- `open`: full check, then `gh pr create --draft --base <protectedBranch>`; mark ready only when the user says so (that starts CI).
- `close`: remove the table row; record evidence (what was fixed, screenshot or test proof) in the notes file the repo uses.
- `status`: list table rows whose branch has had no push for 3+ days.

Never push to the protected branch. Never open a PR to it from a non `ship/*`/`hotfix/*` branch. Delegated children follow the prompt block in BATCH.md.
