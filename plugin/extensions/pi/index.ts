// pi extension entry point for slop-review.
//
// Heavily adapted from the upstream pi-diff-review by Mario Zechner
// (https://github.com/badlogic/pi-diff-review), which is the reason this
// project exists at all. The Escape-to-cancel waiting UI, the message wiring,
// and the overall command shape are taken from upstream's `src/index.ts`
// almost verbatim. Differences from upstream:
//
//   - Command name `slop-review` (not `diff-review`)
//   - Accepts `[base|last-commit|uncommitted|all] [--base <ref>]` args, mirroring
//     the standalone CLI surface so behavior is consistent across all hosts
//   - Default scope is `base` (PR-style: changes since merge-base with the
//     auto-detected base branch), not the upstream's "show all three tabs"
//   - Uses the shared, host-agnostic `createGitOps` factory from `src/git.js`
//     so git invocations go through `pi.exec` (visible in pi's tool log)
//   - Uses the shared `composeReviewPrompt` and `buildReviewHtml` from `src/`
//
// Result delivery is identical to upstream: `ctx.ui.setEditorText(prompt)` —
// the composed feedback gets pumped into pi's input editor for the user to
// review and submit. No temp file is written.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { open, type GlimpseWindow } from "glimpseui";
import { INITIAL_TAB, parseArgs } from "../../src/args.js";
import { createGitOps } from "../../src/git.js";
import { composeReviewPrompt } from "../../src/prompt.js";
import { buildReviewHtml } from "../../src/ui.js";
import type {
  ReviewCancelPayload,
  ReviewCommit,
  ReviewFile,
  ReviewFileContents,
  ReviewHostMessage,
  ReviewRequestFilePayload,
  ReviewSubmitPayload,
  ReviewWindowMessage,
} from "./types.js";

function isSubmitPayload(value: ReviewWindowMessage): value is ReviewSubmitPayload {
  return value.type === "submit";
}

function isCancelPayload(value: ReviewWindowMessage): value is ReviewCancelPayload {
  return value.type === "cancel";
}

function isRequestFilePayload(value: ReviewWindowMessage): value is ReviewRequestFilePayload {
  return value.type === "request-file";
}

type WaitingEditorResult = "escape" | "window-settled";

function escapeForInlineScript(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

const SCOPE_COMPLETIONS: AutocompleteItem[] = [
  { value: "base", label: "base", description: "all changes since merge-base with auto-detected base branch (default)" },
  { value: "last-commit", label: "last-commit", description: "HEAD vs HEAD^" },
  { value: "uncommitted", label: "uncommitted", description: "working tree vs HEAD" },
  { value: "all", label: "all", description: "browse all files (debug)" },
];

export default function (pi: ExtensionAPI) {
  // Build a git ops bundle bound to pi.exec so git invocations show up in
  // pi's tool log. Reused for the lifetime of the extension; pi.exec is stable.
  const git = createGitOps({
    exec: (command, args, options) => pi.exec(command, args, options),
  });

  let activeWindow: GlimpseWindow | null = null;
  let activeWaitingUIDismiss: (() => void) | null = null;

  function closeActiveWindow(): void {
    if (activeWindow == null) return;
    const windowToClose = activeWindow;
    activeWindow = null;
    try {
      windowToClose.close();
    } catch {}
  }

  // -----------------------------------------------------------------
  // Waiting UI: an in-terminal overlay rendered while the Glimpse window
  // is open. Pressing Escape cancels the review and closes the window.
  // Verbatim port of upstream pi-diff-review's WaitingUI.
  // -----------------------------------------------------------------
  function showWaitingUI(ctx: ExtensionCommandContext): {
    promise: Promise<WaitingEditorResult>;
    dismiss: () => void;
  } {
    let settled = false;
    let doneFn: ((result: WaitingEditorResult) => void) | null = null;
    let pendingResult: WaitingEditorResult | null = null;

    const finish = (result: WaitingEditorResult): void => {
      if (settled) return;
      settled = true;
      if (activeWaitingUIDismiss === dismiss) {
        activeWaitingUIDismiss = null;
      }
      if (doneFn != null) {
        doneFn(result);
      } else {
        pendingResult = result;
      }
    };

    const promise = ctx.ui.custom<WaitingEditorResult>((_tui, theme, _kb, done) => {
      doneFn = done;
      if (pendingResult != null) {
        const result = pendingResult;
        pendingResult = null;
        queueMicrotask(() => done(result));
      }

      return {
        render(width: number): string[] {
          const innerWidth = Math.max(24, width - 2);
          const borderTop = theme.fg("border", `╭${"─".repeat(innerWidth)}╮`);
          const borderBottom = theme.fg("border", `╰${"─".repeat(innerWidth)}╯`);
          const lines = [
            theme.fg("accent", theme.bold("Waiting for slop review")),
            "The native review window is open.",
            "Press Escape to cancel and close the review window.",
          ];
          return [
            borderTop,
            ...lines.map(
              (line) =>
                `${theme.fg("border", "│")}${truncateToWidth(line, innerWidth, "...", true).padEnd(innerWidth, " ")}${theme.fg("border", "│")}`,
            ),
            borderBottom,
          ];
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) {
            finish("escape");
          }
        },
        invalidate(): void {},
      };
    });

    const dismiss = (): void => {
      finish("window-settled");
    };

    activeWaitingUIDismiss = dismiss;

    return { promise, dismiss };
  }

  // -----------------------------------------------------------------
  // Resolve scope context (which gitDiffOriginalRef to use, what to
  // label the "git diff" tab, etc.). Mirrors the CLI's
  // resolveScopeContext exactly so the two surfaces stay in lockstep.
  // -----------------------------------------------------------------
  async function resolveScopeContext(
    repoRoot: string,
    parsed: { scope: string; base: string | null },
    ctx: ExtensionCommandContext,
  ): Promise<{
    gitDiffOriginalRef: string;
    scopeLabels: Record<string, string> | null;
    scopeHints: Record<string, string> | null;
    baseRefName: string | null;
  }> {
    if (parsed.scope !== "base") {
      return { gitDiffOriginalRef: "HEAD", scopeLabels: null, scopeHints: null, baseRefName: null };
    }

    const baseRefName = await git.resolveBaseRef(repoRoot, parsed.base);
    if (!baseRefName) {
      ctx.ui.notify(
        parsed.base
          ? `Base ref "${parsed.base}" not found; falling back to "uncommitted" scope.`
          : `Could not auto-detect a base branch; falling back to "uncommitted" scope.`,
        "warning",
      );
      return { gitDiffOriginalRef: "HEAD", scopeLabels: null, scopeHints: null, baseRefName: null };
    }

    const mergeBase = await git.resolveMergeBase(repoRoot, baseRefName);
    if (!mergeBase) {
      ctx.ui.notify(`No merge-base between HEAD and ${baseRefName}; falling back to "uncommitted" scope.`, "warning");
      return { gitDiffOriginalRef: "HEAD", scopeLabels: null, scopeHints: null, baseRefName: null };
    }

    return {
      gitDiffOriginalRef: mergeBase,
      scopeLabels: { "git-diff": `vs ${baseRefName}` },
      scopeHints: {
        "git-diff": `Review all changes since the merge-base with ${baseRefName} (committed and uncommitted). Hover or click line numbers in the gutter to add an inline comment.`,
      },
      baseRefName,
    };
  }

  // -----------------------------------------------------------------
  // Main handler.
  // -----------------------------------------------------------------
  async function reviewRepository(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
    if (activeWindow != null) {
      ctx.ui.notify("A review window is already open.", "warning");
      return;
    }

    let parsed;
    try {
      const argv = rawArgs.trim().length > 0 ? rawArgs.trim().split(/\s+/) : [];
      parsed = parseArgs(argv);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`slop-review: ${msg}`, "error");
      return;
    }
    if (parsed.help) {
      ctx.ui.notify(
        "Usage: /slop-review [base|last-commit|uncommitted|all] [--base <ref>]",
        "info",
      );
      return;
    }

    const repoRoot = await git.getRepoRoot(ctx.cwd);
    const scopeCtx = await resolveScopeContext(repoRoot, parsed, ctx);

    const { files, commits }: { files: ReviewFile[]; commits: ReviewCommit[] } = await git.getReviewWindowData(ctx.cwd, {
      gitDiffOriginalRef: scopeCtx.gitDiffOriginalRef,
    });
    if (files.length === 0) {
      ctx.ui.notify("No reviewable files found.", "info");
      return;
    }

    const initialScope = INITIAL_TAB[parsed.scope as keyof typeof INITIAL_TAB];
    const html = buildReviewHtml({
      repoRoot,
      files,
      commits,
      initialScope,
      scopeLabels: scopeCtx.scopeLabels,
      scopeHints: scopeCtx.scopeHints,
      baseRefName: scopeCtx.baseRefName,
    });

    const titleSuffix = scopeCtx.baseRefName ? ` (vs ${scopeCtx.baseRefName})` : ` (${parsed.scope})`;
    const window = open(html, {
      width: 1680,
      height: 1020,
      title: `slop review${titleSuffix}`,
    });
    activeWindow = window;

    const waitingUI = showWaitingUI(ctx);
    const fileMap = new Map(files.map((file) => [file.id, file]));
    const contentCache = new Map<string, Promise<ReviewFileContents>>();

    const sendWindowMessage = (message: ReviewHostMessage): void => {
      if (activeWindow !== window) return;
      const payload = escapeForInlineScript(JSON.stringify(message));
      window.send(`window.__reviewReceive(${payload});`);
    };

    const loadContents = (
      file: ReviewFile,
      scope: ReviewRequestFilePayload["scope"],
      commitSha?: string,
    ): Promise<ReviewFileContents> => {
      const cacheKey = `${scope}:${commitSha ?? ""}:${file.id}`;
      const cached = contentCache.get(cacheKey);
      if (cached != null) return cached;
      const pending = git.loadReviewFileContents(repoRoot, file, scope, {
        gitDiffOriginalRef: scopeCtx.gitDiffOriginalRef,
        commitSha,
      });
      contentCache.set(cacheKey, pending);
      return pending;
    };

    ctx.ui.notify(
      `Opened slop review for ${files.length} file${files.length === 1 ? "" : "s"}${scopeCtx.baseRefName ? ` (vs ${scopeCtx.baseRefName})` : ""}.`,
      "info",
    );

    try {
      const terminalMessagePromise = new Promise<ReviewSubmitPayload | ReviewCancelPayload | null>((resolve, reject) => {
        let settled = false;

        const cleanup = (): void => {
          window.removeListener("message", onMessage);
          window.removeListener("closed", onClosed);
          window.removeListener("error", onError);
          if (activeWindow === window) {
            activeWindow = null;
          }
        };

        const settle = (value: ReviewSubmitPayload | ReviewCancelPayload | null): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };

        const handleRequestFile = async (message: ReviewRequestFilePayload): Promise<void> => {
          const file = fileMap.get(message.fileId);
          if (file == null) {
            sendWindowMessage({
              type: "file-error",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              commitSha: message.commitSha,
              message: "Unknown file requested.",
            });
            return;
          }

          try {
            const contents = await loadContents(file, message.scope, message.commitSha);
            sendWindowMessage({
              type: "file-data",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              commitSha: message.commitSha,
              originalContent: contents.originalContent,
              modifiedContent: contents.modifiedContent,
            });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            sendWindowMessage({
              type: "file-error",
              requestId: message.requestId,
              fileId: message.fileId,
              scope: message.scope,
              commitSha: message.commitSha,
              message: messageText,
            });
          }
        };

        const onMessage = (data: unknown): void => {
          const message = data as ReviewWindowMessage;
          if (isRequestFilePayload(message)) {
            void handleRequestFile(message);
            return;
          }
          if (isSubmitPayload(message) || isCancelPayload(message)) {
            settle(message);
          }
        };

        const onClosed = (): void => {
          settle(null);
        };

        const onError = (error: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };

        window.on("message", onMessage);
        window.on("closed", onClosed);
        window.on("error", onError);
      });

      const result = await Promise.race([
        terminalMessagePromise.then((message) => ({ type: "window" as const, message })),
        waitingUI.promise.then((reason) => ({ type: "ui" as const, reason })),
      ]);

      if (result.type === "ui" && result.reason === "escape") {
        closeActiveWindow();
        await terminalMessagePromise.catch(() => null);
        ctx.ui.notify("Slop review cancelled.", "info");
        return;
      }

      const message = result.type === "window" ? result.message : await terminalMessagePromise;

      waitingUI.dismiss();
      await waitingUI.promise;
      closeActiveWindow();

      if (message == null || message.type === "cancel") {
        ctx.ui.notify("Slop review cancelled.", "info");
        return;
      }

      const prompt = composeReviewPrompt(files, message);
      ctx.ui.setEditorText(prompt);
      ctx.ui.notify("Inserted review feedback into the editor.", "info");
    } catch (error) {
      activeWaitingUIDismiss?.();
      closeActiveWindow();
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Slop review failed: ${message}`, "error");
    }
  }

  pi.registerCommand("slop-review", {
    description: "Open the native slop-review window for PR-style changes or a selected recent commit.",
    getArgumentCompletions: (argumentPrefix: string): AutocompleteItem[] | null => {
      // First argument: scope name. After that, --base flag with no completion.
      const trimmed = argumentPrefix.trimStart();
      if (trimmed.length === 0 || !trimmed.includes(" ")) {
        const lower = trimmed.toLowerCase();
        return SCOPE_COMPLETIONS.filter((item) => item.value.toLowerCase().startsWith(lower));
      }
      return null;
    },
    handler: async (args, ctx) => {
      await reviewRepository(args, ctx);
    },
  });

  pi.on("session_shutdown", async () => {
    activeWaitingUIDismiss?.();
    closeActiveWindow();
  });
}
