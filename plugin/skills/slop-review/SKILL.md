---
name: slop-review
description: Open the native, Monaco-powered diff review window so the user can leave inline / file-level / overall comments on the current changes (the AI slop), then address each comment. Use this when the user asks to "review my changes", "review the slop", "review my diff", "open a diff review", "open the review window", "get feedback on my work", "do a PR-style review", "show me what I changed and let me comment", or types `@slop-review` explicitly. Defaults to a PR-style review of all commits + uncommitted changes since the merge-base with the auto-detected base branch (origin/HEAD → origin/main → main → origin/master → master); also supports last-commit, uncommitted, and all-files modes.
---

# slop-review

Open the native diff review window, wait for the user to submit feedback, then address each comment they wrote.

## When to use

- User asks for a "review", "diff review", "PR review", "slop review", or "feedback on my changes"
- User says they want to "look at" or "comment on" their current changes before continuing
- User explicitly invokes `@slop-review`

If the user has not made any changes yet, say so and skip this skill.

## Step 1 — invoke the dispatcher via the shell tool

The plugin ships a self-contained dispatcher script. Invoke it via your shell tool with this exact command (substituting the user's intent for `<args>`):

```bash
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -x "${CLAUDE_PLUGIN_ROOT}/bin/plugin-run.sh" ]; then
	bash "${CLAUDE_PLUGIN_ROOT}/bin/plugin-run.sh" <args>
elif [ -n "${CODEX_PLUGIN_ROOT:-}" ] && [ -x "${CODEX_PLUGIN_ROOT}/bin/plugin-run.sh" ]; then
	bash "${CODEX_PLUGIN_ROOT}/bin/plugin-run.sh" <args>
elif command -v slop-review >/dev/null 2>&1; then
	slop-review <args>
else
	echo "slop-review is not available. Install the plugin via your agent's plugin/marketplace command, or run: npm install -g slop-review" >&2
	exit 1
fi
```

Agent plugin hosts expose the plugin checkout through an environment variable such as `${CLAUDE_PLUGIN_ROOT}` or `${CODEX_PLUGIN_ROOT}`. The shell block above checks both names, then falls back to a globally installed `slop-review` binary. On first invocation the dispatcher does a one-time `npm install` inside the plugin checkout to pull `glimpseui` and build its native helper, then exec's the CLI.

`<args>` is one of:

| User intent | Pass |
|---|---|
| Default / "review my changes" / "PR-style review" | *(no args)* |
| "review my last commit" | `last-commit` |
| "review only what's uncommitted" / "review my working tree" | `uncommitted` |
| Override the auto-detected base branch | `--base <ref>` |
| Just browse the working tree (debug) | `all` |

A native window will open. **The shell call will block until the user clicks Submit feedback or closes the window — this can take minutes. Do not run other tool calls in parallel; just wait.**

## Step 2 — interpret the dispatcher's stdout

The dispatcher writes a single line of stdout. Status / progress messages are on stderr; ignore those for parsing.

| stdout | What to do |
|---|---|
| `FEEDBACK_FILE: <absolute path>` | Read that file with your file-reading tool. The contents are numbered review comments, optionally with an "Overall" comment block. Address each numbered item carefully (edit code, run tests, etc.). When done, give the user a brief summary item-by-item. |
| `REVIEW_CANCELLED` | Reply with a single short line confirming the review was cancelled. Do nothing else. |
| Anything else (e.g. an error) | Surface the error verbatim and stop. |

## Notes

- The CLI writes its feedback file under `$TMPDIR/slop-review-<timestamp>.md`. It's a regular file you can `cat`, `wc`, etc.
- If the dispatcher reports that `glimpseui`'s native helper failed to build, follow the exact remediation it prints (usually: install Xcode Command Line Tools on macOS, then re-run).
- This skill never modifies files on its own — it only opens the review UI. All code changes happen in Step 2 after you've read the user's feedback.
