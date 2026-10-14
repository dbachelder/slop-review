---
description: Open a native diff review window (Monaco-powered) and address the resulting feedback
argument-hint: "[base|last-commit|uncommitted|all] [--base <ref>]"
---

# /slop-review

Open the native diff review window so the user can leave inline / file-level / overall comments on the current changes or a selected recent commit, then address each comment.

## Step 1 — run the dispatcher

Invoke this exact shell command using your shell/bash tool. The window will block until the user clicks **Submit feedback** or closes it, so this call may take a long time — that is expected. Do **not** run anything else in parallel; wait for it to finish.

```bash
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -x "${CLAUDE_PLUGIN_ROOT}/bin/plugin-run.sh" ]; then
  bash "${CLAUDE_PLUGIN_ROOT}/bin/plugin-run.sh" $ARGUMENTS
elif [ -n "${CODEX_PLUGIN_ROOT:-}" ] && [ -x "${CODEX_PLUGIN_ROOT}/bin/plugin-run.sh" ]; then
  bash "${CODEX_PLUGIN_ROOT}/bin/plugin-run.sh" $ARGUMENTS
elif command -v slop-review >/dev/null 2>&1; then
  slop-review $ARGUMENTS
else
  echo "slop-review is not available. Install the plugin via your agent's plugin/marketplace command, or run: npm install -g slop-review" >&2
  exit 1
fi
```

Substitute the user's `$ARGUMENTS` into that block verbatim. Valid first arguments:

- *(none)* — default `base` scope: all changes since the merge-base with the auto-detected base branch (`origin/HEAD` → `origin/main` → `main` → `origin/master` → `master`).
- `last-commit` — `HEAD^ → HEAD`.
- `uncommitted` — working-tree changes vs `HEAD`.
- `all` — debug / browse-only.
- `--base <ref>` — override the auto-detected base branch (only meaningful with `base`).

The window's **Commits** tab lets the user select one of the 50 most recent commits; no additional argument is needed.

## Step 2 — interpret the dispatcher's stdout

Read the captured stdout from the previous step:

- **`FEEDBACK_FILE: <absolute path>`** → use the file-reading tool to load that file. Its contents are numbered review comments, optionally with an "Overall" comment block. Address each numbered item carefully (edit code, run tests, etc.). When done, give the user a brief summary of what you changed, item by item.
- **`REVIEW_CANCELLED`** → reply with a single short line confirming the review was cancelled. Do not do anything else.
- **anything else** (e.g. an error) → surface the error to the user verbatim and stop.

Status / progress messages from the dispatcher are written to **stderr**, not stdout, so they don't affect the parsing above.
