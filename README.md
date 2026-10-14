# slop-review

A native diff review window for terminal coding agents, powered by [Glimpse](https://github.com/hazat/glimpse) and [Monaco](https://microsoft.github.io/monaco-editor/). Ships for **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)**, **[Codex CLI](https://github.com/openai/codex)**, and **[pi](https://pi.dev)** — review the slop before you ship it.

- In **Claude Code** it adds a `/slop-review` slash command.
- In **Codex CLI** it ships as a `slop-review` skill (auto-invoked when you ask for a review, or explicitly via `@slop-review`).
- In **pi** it registers a `/slop-review` slash command (the upstream this is forked from — see Credit below).

All three:

1. Open a native review window
2. Default to a **PR-style review** of all changes since your branch diverged from the base branch (auto-detected: `origin/HEAD` → `origin/main` → `main` → `origin/master` → `master`), and also support `last-commit` and `uncommitted` modes — see [Scopes](#scopes)
3. Let you select and review any of the 50 most recent commits
4. Show a collapsible sidebar with fuzzy file search and git status markers
5. Lazy-load file contents on demand as you switch files and scopes
6. Let you draft comments on the original side, modified side, or whole file
7. Write the composed feedback to a temp file when you submit; the agent reads it back, so the review shows up in the chat as a regular tool call and gets addressed item-by-item

![slop-review reviewing its own README change](docs/screenshot.png)

## Install

Three hosts, three install paths. All three end with the same review window.

### pi

```bash
# Recommended: from npm (also lists on https://pi.dev/packages)
pi install npm:pi-slop-review

# Or from GitHub (handy for unreleased commits)
pi install git:github.com/dbachelder/slop-review

# Or pin to a tag
pi install git:github.com/dbachelder/slop-review@v0.5.0

# Or try without installing (single-run)
pi -e npm:pi-slop-review
```

Then inside pi:

```
/slop-review                       # default: PR-style review
/slop-review last-commit
/slop-review --base origin/develop
```

When you submit feedback, the composed prompt drops into pi's input editor
(idiomatic for pi — same UX as the upstream `pi-diff-review`). Press
`Escape` while the window is open to cancel.

> **Note on the npm name.** The npm package is `pi-slop-review` (matches
> pi.dev's gallery `pi-<name>` convention). The slash command, the bin name,
> and the plugin name everywhere else are still `slop-review`.

### Claude Code

```bash
# inside Claude Code
/plugin marketplace add dbachelder/slop-review
/plugin install slop-review@slop-review
```

This registers the `/slop-review` slash command.

### Codex CLI

Codex separates marketplace registration (CLI) from plugin enablement (TUI).
Both steps are required:

```bash
# 1. Register the marketplace
codex plugin marketplace add dbachelder/slop-review
```

```
# 2. Inside `codex`, type:
/plugins
```

In the plugin browser, switch to the `Slop Review` (slop-review) marketplace
tab, select the `slop-review` plugin, and press *Install plugin*. This enables
the `slop-review` skill, which the model auto-loads when you ask it to review
your changes (or which you can invoke explicitly with `@slop-review`).

> **Why a skill instead of a slash command in Codex?** Codex's plugin system
> doesn't expose user-defined slash commands; it uses *skills* (markdown the
> model loads when descriptions match the user's intent) and `@`-invocation.

If you prefer to skip the TUI, enable the plugin by editing
`~/.codex/config.toml`:

```toml
[plugins."slop-review@slop-review"]
enabled = true
```

Then restart Codex.

### How updates flow

| Host | Install source | Update command |
|---|---|---|
| pi | npm (`pi-slop-review`) or GitHub clone | `pi update` |
| Claude Code | GitHub marketplace (`dbachelder/slop-review`) | `/plugin update` |
| Codex CLI | GitHub marketplace (`dbachelder/slop-review`) | `codex plugin marketplace upgrade slop-review` |

For Claude Code and Codex, the GitHub marketplace clone runs a one-time
`npm install` inside the plugin checkout on first invocation — that's what
installs [`glimpseui`](https://www.npmjs.com/package/glimpseui) and builds
its per-platform native helper. Codex sets `CLAUDE_PLUGIN_ROOT` for plugin
shell calls so the same dispatcher works in both agents with no
special-casing. A stamp file under `plugin/node_modules/` makes the
dispatcher skip `npm install` unless `plugin/package.json` actually
changed.

### Standalone CLI / development install

```bash
git clone https://github.com/dbachelder/slop-review.git
cd slop-review/plugin
npm install
npm install -g .                # puts `slop-review` on PATH as a standalone binary
npm run install-command         # copies commands/slop-review.md → ~/.claude/commands/
```

All the plugin contents live under `slop-review/plugin/`. The top-level
`slop-review/` directory holds only the two marketplace manifests, the
root `package.json` (which exists solely to point pi's `git:` install at
the extension under `./plugin/`), and `README` / `LICENSE` / `NOTICE`.

## Credit

This is a fork of **[badlogic/pi-diff-review](https://github.com/badlogic/pi-diff-review)** by [Mario Zechner](https://github.com/badlogic), which provides the same UI for [`pi`](https://pi.dev). All of the heavy lifting — the Glimpse window orchestration, the Monaco-based review UI, the comment-and-prompt pipeline, and the in-terminal Escape-to-cancel waiting overlay (in our pi adapter) — was designed and implemented there. This repo:

- Adds a standalone Node CLI (`plugin/bin/slop-review.js`) so the same UI can be driven from any host that can shell out.
- Adds Claude Code (slash command) and Codex CLI (skill) adapters that use a temp-file + `Read` round-trip so the review stays visible in the chat UI.
- Adds a pi extension under `plugin/extensions/pi/` that registers `/slop-review` in pi (parallel to the upstream's `/diff-review`) and uses upstream's idiomatic `setEditorText` flow — same UX as the upstream.
- Adds PR-style review (everything since merge-base with the auto-detected base branch) as the default scope, with explicit `last-commit`, `uncommitted`, and `all` modes also available.
- Keeps `plugin/web/index.html` and `plugin/web/app.js` from the upstream essentially unchanged.

If you only use pi and just want the upstream behavior, install [`badlogic/pi-diff-review`](https://github.com/badlogic/pi-diff-review) instead. Please ⭐ the upstream regardless.

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex CLI](https://github.com/openai/codex), **or** [pi](https://pi.dev)
- Internet access at runtime for the Tailwind and Monaco CDNs used by the review window
- **Native build toolchain** — Glimpse compiles a per-platform native helper on first install:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: Rust (https://rustup.rs) + GTK4/WebKit2GTK dev packages
    - Fedora: `dnf install gtk4-devel webkitgtk6.0-devel gtk4-layer-shell-devel`
    - Ubuntu: `apt install libgtk-4-dev libwebkitgtk-6.0-dev libgtk4-layer-shell-dev`
    - Arch: `pacman -S gtk4 webkitgtk-6.0 gtk4-layer-shell`
  - **Windows**: .NET 8 SDK

  Claude Code and some other agents run `npm install --ignore-scripts` when materializing plugins, which suppresses Glimpse's normal postinstall build. `plugin/bin/plugin-run.sh` detects this and re-builds the helper explicitly on first invocation, so you'll see a one-time delay (a few seconds for Swift, longer for Rust) before the review window opens.

### Windows notes

Glimpse supports Windows, but the native host build during install requires:

- .NET 8 SDK
- Microsoft Edge WebView2 Runtime

## Usage

### From Claude Code

```
/slop-review                       # default: all changes since base branch merge-base
/slop-review last-commit           # only HEAD vs HEAD^
/slop-review uncommitted           # only working-tree changes vs HEAD
/slop-review --base origin/develop # override the base branch
```

The slash command declares an `argument-hint`, so Claude Code's input autocompletes the available forms.

### From pi

```
/slop-review                       # default: all changes since base branch merge-base
/slop-review last-commit
/slop-review uncommitted
/slop-review --base origin/develop
```

The pi adapter also registers an autocomplete for the scope argument, so
tab-complete works in pi's input.

When you submit, the composed feedback is dropped into pi's input editor for
you to review and send. While the window is open, press `Escape` from the
pi terminal to cancel.

### From Codex CLI

Just ask for a review in natural language and the `slop-review` skill auto-loads:

```
> review my changes
> review the slop on this branch against main
> open a PR-style review
```

Or invoke it explicitly:

```
> @slop-review
> @slop-review last-commit
> @slop-review --base origin/develop
```

### What happens

A native window opens. Browse the current diff or choose **Commits** to select one of the 50 most recent commits, leave inline or whole-file comments, then click **Submit feedback**. The CLI writes your feedback to `$TMPDIR/slop-review-<timestamp>.md` and prints the path. The agent then reads the file (visible in the UI as a `Read` / file-read tool call) and addresses each item. Click **Cancel** or close the window to abort.

### Standalone CLI

The binary is a normal Node CLI; nothing about it is agent-specific. You can invoke it directly to drive your own tool integrations:

```
slop-review [base|last-commit|uncommitted|all] [--base <ref>] [--help]
```

Contract:

| Outcome | stdout | exit |
|---|---|---|
| User submits feedback | `FEEDBACK_FILE: <absolute path>\n` | `0` |
| User cancels / closes window / no reviewable files | `REVIEW_CANCELLED\n` | `0` |
| Bad arguments | (nothing; usage on stderr) | `2` |
| Other error | (nothing; error on stderr) | `1` |

Status messages ("Opened review window…", base-ref resolution, etc.) go to **stderr**, so stdout stays clean for piping. Example:

```bash
out=$(slop-review last-commit)
case "$out" in
  FEEDBACK_FILE:*) cat "${out#FEEDBACK_FILE: }" ;;
  REVIEW_CANCELLED) echo "cancelled" ;;
esac
```

### Scopes

| Scope | Compares | Use when |
|---|---|---|
| `base` *(default)* | merge-base of HEAD and base branch → working tree | You want the full PR-style review of everything you've done on this branch, committed or not. Base branch is auto-detected: `origin/HEAD` → `origin/main` → `main` → `origin/master` → `master`. Override with `--base <ref>`. |
| `last-commit` | HEAD^ → HEAD | You just committed and want to review only that commit. |
| `uncommitted` | HEAD → working tree | You want to review only what's still unstaged/staged but not committed. |
| `all` | (no diff; shows working tree) | Browsing the tree without a diff scope. Mostly for debugging. |

In `base` mode, the "git diff" tab in the window is relabelled `vs <base-ref>` so you can tell which ref you're comparing against. If no base branch is found, the CLI falls back to `uncommitted` and logs a warning.

Every mode also exposes a **Commits** tab. Its dropdown lists the 50 most recent commits as `<short-sha> <subject>` and compares the selected commit to its first parent.

## How it works

```
  Agent                     bash plugin-run.sh                slop-review
  /slop-review        ───────────────────────────────────►    (Node CLI)
  @slop-review                                                     │
                                                                   │ glimpseui
                                                                   ▼
                          "FEEDBACK_FILE: <path>"             Native window
                       ◄──────────────────────────            (Monaco diff)
  Read tool: <path>
        │
        ▼
  feedback rendered in chat, agent addresses each item
```

The two-step (`Bash` → `Read`) flow is what makes the review visible in the
chat UI: the bash output alone gets folded into the prompt as context, but
the subsequent `Read` of the feedback file shows up as a regular tool call
with the full file contents.

- **`plugin/bin/slop-review.js`** — CLI entry. Parses arguments, resolves the base ref + merge-base when in `base` mode, opens the Glimpse window, handles file-content requests. On submit, writes the composed prompt to `$TMPDIR/slop-review-<ts>.md` and prints `FEEDBACK_FILE: <path>` to stdout. On cancel, prints `REVIEW_CANCELLED`.
- **`plugin/bin/plugin-run.sh`** — Plugin dispatcher. Resolves the plugin root from `$CLAUDE_PLUGIN_ROOT` (set by both Claude Code and Codex), `npm install`s on first run, then exec's the CLI.
- **`plugin/src/git.js`** — Git scope/diff loader, including recent commit metadata and per-commit comparisons (ported from `src/git.ts`).
- **`plugin/src/prompt.js`** — Feedback prompt composer (ported verbatim from `src/prompt.ts`).
- **`plugin/src/ui.js`** — Inlines `web/index.html` + `web/app.js` for the Glimpse window.
- **`plugin/web/`** — Static UI assets (Monaco, Tailwind via CDN, app logic). Copied from upstream.
- **`plugin/commands/slop-review.md`** — Claude Code slash command. Forwards `$ARGUMENTS` to the dispatcher, then instructs Claude to `Read` the feedback file and address each item.
- **`plugin/skills/slop-review/SKILL.md`** — Codex skill. Same instructions, formatted as a skill that the model auto-loads when the user asks for a review.

## Layout

```
slop-review/
├── .claude-plugin/
│   └── marketplace.json          # Claude Code marketplace (string source: "./plugin")
├── .agents/plugins/
│   └── marketplace.json          # Codex CLI marketplace (object source, path: "./plugin")
├── .github/workflows/
│   └── publish-npm.yml           # publishes plugin/ to npm on `v*` tag push
├── package.json                  # ROOT manifest — read only by `pi install git:`
│                                  # so pi finds `pi.extensions: ./plugin/extensions/pi/index.ts`
├── docs/
│   └── screenshot.png            # README image (also used by pi.image gallery preview)
├── scripts/
│   └── bump-version.mjs          # bumps all 6 manifests + lockfiles + README;
│                                  # commits + tags. Run `scripts/bump-version.mjs --help`.
├── plugin/                       # Actual plugin contents — both marketplaces point here
│                                  # AND this is what gets published to npm as `pi-slop-review`
│   ├── .claude-plugin/
│   │   └── plugin.json           # Claude Code plugin manifest
│   ├── .codex-plugin/
│   │   └── plugin.json           # Codex CLI plugin manifest
│   ├── bin/
│   │   ├── slop-review.js        # CLI entry point (Claude + Codex)
│   │   └── plugin-run.sh         # Plugin dispatcher (Claude + Codex)
│   ├── src/                      # SHARED across all three host adapters
│   │   ├── args.js               # arg parser (CLI + pi)
│   │   ├── git.js                # createGitOps({ exec }) — host injects exec
│   │   ├── prompt.js             # composes the feedback prompt
│   │   └── ui.js                 # inlines web/ into a single HTML doc
│   ├── web/                      # Monaco UI bundle (mostly unchanged from upstream)
│   │   ├── index.html
│   │   └── app.js
│   ├── commands/
│   │   └── slop-review.md        # Claude Code slash command
│   ├── skills/
│   │   └── slop-review/
│   │       └── SKILL.md          # Codex skill (auto-loaded; @-invokable)
│   ├── extensions/
│   │   └── pi/
│   │       ├── index.ts          # pi extension entry (registers /slop-review)
│   │       └── types.ts          # wire-format types for the Glimpse ↔ host channel
│   ├── scripts/
│   │   └── install-command.js
│   └── package.json              # name: pi-slop-review; bin: slop-review;
│                                  # pi.extensions: extensions/pi/index.ts
├── LICENSE
├── NOTICE
└── README.md
```

Two `package.json` files is the floor: Claude Code and Codex only see the
contents of `./plugin/` after install (their marketplace path points
there), so the npm-publishable plugin manifest must live inside `./plugin/`.
pi's `git:` install reads `package.json` at the cloned repo root, so a thin
root manifest is needed there too. The two files describe the same plugin
for different consumers; only `plugin/package.json` is published to npm.

Codex's marketplace path validator rejects `./` outright
(`local plugin source path must not be empty`), which is why the actual
plugin lives in `./plugin/` instead of at the repo root.


## Differences from the upstream pi extension

| Concern | pi-diff-review | slop-review |
|---|---|---|
| Hosts | pi only | pi + Claude Code + Codex CLI |
| pi command name | `/diff-review` | `/slop-review` |
| Default scope | Git diff, last commit, recent commits, and all files; no default scope | PR-style: changes since merge-base with auto-detected base branch; recent commits remain selectable |
| Args | (none) | `[base\|last-commit\|uncommitted\|all] [--base <ref>]` |
| pi result delivery | `ctx.ui.setEditorText(prompt)` | Same |
| pi waiting UI | pi-tui custom panel + Escape-to-cancel | Same (verbatim port) |
| Claude/Codex result delivery | n/a | Temp file path on stdout → agent `Read`s the file (visible in chat UI) |
| Git execution (pi) | `pi.exec` | Same (host-injected via `createGitOps({ exec: pi.exec })`) |
| Git execution (Claude/Codex) | n/a | `node:child_process` |
| Language | TypeScript | TypeScript for the pi extension; plain ESM JavaScript everywhere else |

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The Monaco Editor and Tailwind assets are loaded from public CDNs; their respective licenses apply.
