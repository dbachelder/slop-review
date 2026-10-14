// Ported from pi-diff-review (https://github.com/badlogic/pi-diff-review)
// Original: src/git.ts.
//
// Refactored to a factory pattern: callers inject an `exec` callable that
// matches @earendil-works/pi-coding-agent's `pi.exec(command, args, opts)`
// signature. The standalone CLI uses a `node:child_process`-backed default;
// the pi extension passes `pi.exec` directly so git invocations show up in
// pi's tool log.
//
// Extension over upstream: getReviewWindowData accepts an optional
// `gitDiffOriginalRef` (e.g. a merge-base SHA) so the "git-diff" scope can
// mean "vs base branch" instead of always "vs HEAD". loadReviewFileContents
// accepts the same.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

// ---------- pure helpers (no exec/IO) ----------

function parseNameStatus(output) {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const changes = [];
  for (const line of lines) {
    const parts = line.split("\t");
    const rawStatus = parts[0] ?? "";
    const code = rawStatus[0];
    if (code === "R") {
      const oldPath = parts[1] ?? null;
      const newPath = parts[2] ?? null;
      if (oldPath != null && newPath != null) changes.push({ status: "renamed", oldPath, newPath });
      continue;
    }
    if (code === "M") {
      const path = parts[1] ?? null;
      if (path != null) changes.push({ status: "modified", oldPath: path, newPath: path });
      continue;
    }
    if (code === "A") {
      const path = parts[1] ?? null;
      if (path != null) changes.push({ status: "added", oldPath: null, newPath: path });
      continue;
    }
    if (code === "D") {
      const path = parts[1] ?? null;
      if (path != null) changes.push({ status: "deleted", oldPath: path, newPath: null });
    }
  }
  return changes;
}

function parseUntrackedPaths(output) {
  return output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    .map((path) => ({ status: "added", oldPath: null, newPath: path }));
}

function parseTrackedPaths(output) {
  return output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

function mergeChangedPaths(tracked, untracked) {
  const seen = new Set(tracked.map((c) => `${c.status}:${c.oldPath ?? ""}:${c.newPath ?? ""}`));
  const merged = [...tracked];
  for (const change of untracked) {
    const key = `${change.status}:${change.oldPath ?? ""}:${change.newPath ?? ""}`;
    if (seen.has(key)) continue;
    merged.push(change);
    seen.add(key);
  }
  return merged;
}

const uniquePaths = (paths) => [...new Set(paths)];

function toDisplayPath(change) {
  if (change.status === "renamed") return `${change.oldPath ?? ""} -> ${change.newPath ?? ""}`;
  return change.newPath ?? change.oldPath ?? "(unknown)";
}

function toComparison(change) {
  return {
    status: change.status,
    oldPath: change.oldPath,
    newPath: change.newPath,
    displayPath: toDisplayPath(change),
    hasOriginal: change.oldPath != null,
    hasModified: change.newPath != null,
  };
}

function buildReviewFileId(path, hasWorkingTreeFile, gitDiff, lastCommit) {
  return [
    path,
    hasWorkingTreeFile ? "working" : "gone",
    gitDiff?.displayPath ?? "",
    lastCommit?.displayPath ?? "",
  ].join("::");
}

function parseCommitLog(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = "", shortSha = "", ...subjectParts] = line.split("\t");
      return { sha, shortSha, subject: subjectParts.join("\t") };
    })
    .filter((commit) => commit.sha.length > 0);
}

function createReviewFile(seed) {
  return {
    id: buildReviewFileId(seed.path, seed.hasWorkingTreeFile, seed.gitDiff, seed.lastCommit),
    path: seed.path,
    worktreeStatus: seed.worktreeStatus,
    hasWorkingTreeFile: seed.hasWorkingTreeFile,
    inGitDiff: seed.inGitDiff,
    inLastCommit: seed.inLastCommit,
    gitDiff: seed.gitDiff,
    lastCommit: seed.lastCommit,
    commitComparisons: seed.commitComparisons,
  };
}

const BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".avif", ".bin", ".bmp", ".class", ".dll", ".dylib",
  ".eot", ".exe", ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".lockb",
  ".map", ".mov", ".mp3", ".mp4", ".o", ".otf", ".pdf", ".png", ".pyc",
  ".so", ".svgz", ".tar", ".ttf", ".wasm", ".webm", ".webp", ".woff",
  ".woff2", ".zip",
]);

function isReviewableFilePath(path) {
  const lowerPath = path.toLowerCase();
  const fileName = lowerPath.split("/").pop() ?? lowerPath;
  const extension = extname(fileName);
  if (fileName.length === 0) return false;
  if (BINARY_EXTENSIONS.has(extension)) return false;
  if (fileName.endsWith(".min.js") || fileName.endsWith(".min.css")) return false;
  return true;
}

const compareReviewFiles = (a, b) => a.path.localeCompare(b.path);

function upsertSeed(seeds, key, create) {
  const existing = seeds.get(key);
  if (existing != null) return existing;
  const seed = create();
  seeds.set(key, seed);
  return seed;
}

async function getWorkingTreeContent(repoRoot, path) {
  try {
    return await readFile(join(repoRoot, path), "utf8");
  } catch {
    return "";
  }
}

// ---------- exec adapter ----------

/**
 * Default exec implementation used by the standalone CLI path. Shape matches
 * @earendil-works/pi-coding-agent's `pi.exec(command, args, options)`:
 *
 *   exec(command: string, args: string[], options?: { cwd?, signal?, timeout? })
 *     => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>
 *
 * In our usage `command` is always "git".
 */
function defaultExec(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, signal: options.signal });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => resolve({ stdout, stderr: err.message, code: -1, killed }));
    child.on("close", (code, signal) => {
      if (signal != null) killed = true;
      resolve({ stdout, stderr, code: code ?? -1, killed });
    });
  });
}

// ---------- factory ----------

/**
 * Build a set of git operations bound to a host-provided `exec` callable.
 *
 * @param {{ exec?: (command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }> }} [deps]
 */
export function createGitOps(deps = {}) {
  const exec = deps.exec ?? defaultExec;

  const execGit = (repoRoot, args) => exec("git", args, { cwd: repoRoot });

  async function runGit(repoRoot, args) {
    const result = await execGit(repoRoot, args);
    if (result.code !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
      throw new Error(message);
    }
    return result.stdout;
  }

  async function runGitAllowFailure(repoRoot, args) {
    const result = await execGit(repoRoot, args);
    if (result.code !== 0) return "";
    return result.stdout;
  }

  async function getRepoRoot(cwd) {
    const result = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
    if (result.code !== 0) {
      throw new Error("Not inside a git repository.");
    }
    return result.stdout.trim();
  }

  async function hasHead(repoRoot) {
    const result = await execGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
    return result.code === 0;
  }

  async function refExists(repoRoot, ref) {
    const result = await execGit(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
    return result.code === 0;
  }

  /**
   * Resolve a base branch ref. If `candidate` is provided, validate it exists.
   * Otherwise auto-detect from common defaults.
   * Returns the canonical ref name (e.g. "origin/main") or null if none found.
   */
  async function resolveBaseRef(repoRoot, candidate) {
    if (candidate) {
      if (await refExists(repoRoot, candidate)) return candidate;
      return null;
    }
    // Try `origin/HEAD` first; resolve to its target if it's a symbolic ref.
    const symRes = await execGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    if (symRes.code === 0) {
      const target = symRes.stdout.trim();
      if (target && await refExists(repoRoot, target)) return target;
    }
    for (const ref of ["origin/main", "main", "origin/master", "master"]) {
      if (await refExists(repoRoot, ref)) return ref;
    }
    return null;
  }

  /** Returns the merge-base SHA of `baseRef` and HEAD, or null. */
  async function resolveMergeBase(repoRoot, baseRef) {
    const result = await execGit(repoRoot, ["merge-base", baseRef, "HEAD"]);
    if (result.code !== 0) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  }

  async function getRevisionContent(repoRoot, revision, path) {
    const result = await execGit(repoRoot, ["show", `${revision}:${path}`]);
    if (result.code !== 0) return "";
    return result.stdout;
  }

  /**
   * @param {string} cwd
   * @param {{ gitDiffOriginalRef?: string }} [options]
   *   gitDiffOriginalRef: ref/SHA that the "git-diff" scope compares against.
   *   Defaults to "HEAD". Pass a merge-base SHA for "vs base branch" mode.
   */
  async function getReviewWindowData(cwd, options = {}) {
    const repoRoot = await getRepoRoot(cwd);
    const repositoryHasHead = await hasHead(repoRoot);
    const gitDiffOriginalRef = options.gitDiffOriginalRef ?? "HEAD";

    const trackedDiffOutput = repositoryHasHead
      ? await runGit(repoRoot, ["diff", "--find-renames", "-M", "--name-status", gitDiffOriginalRef, "--"])
      : "";
    const untrackedOutput = await runGitAllowFailure(repoRoot, ["ls-files", "--others", "--exclude-standard"]);
    const trackedFilesOutput = await runGitAllowFailure(repoRoot, ["ls-files", "--cached"]);
    const deletedFilesOutput = await runGitAllowFailure(repoRoot, ["ls-files", "--deleted"]);
    const lastCommitOutput = repositoryHasHead
      ? await runGitAllowFailure(repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", "HEAD"])
      : "";
    const commits = repositoryHasHead
      ? parseCommitLog(await runGitAllowFailure(repoRoot, ["log", "--max-count=50", "--format=%H%x09%h%x09%s"]))
      : [];
    const commitChanges = new Map();
    for (const commit of commits) {
      const output = await runGitAllowFailure(repoRoot, ["diff-tree", "--root", "--find-renames", "-M", "--name-status", "--no-commit-id", "-r", commit.sha]);
      commitChanges.set(commit.sha, parseNameStatus(output)
        .filter((change) => isReviewableFilePath(change.newPath ?? change.oldPath ?? "")));
    }

    const worktreeChanges = mergeChangedPaths(parseNameStatus(trackedDiffOutput), parseUntrackedPaths(untrackedOutput))
      .filter((c) => isReviewableFilePath(c.newPath ?? c.oldPath ?? ""));
    const deletedPaths = new Set(parseTrackedPaths(deletedFilesOutput));
    const currentPaths = uniquePaths([...parseTrackedPaths(trackedFilesOutput), ...parseTrackedPaths(untrackedOutput)])
      .filter((p) => !deletedPaths.has(p))
      .filter(isReviewableFilePath);
    const lastCommitChanges = parseNameStatus(lastCommitOutput)
      .filter((c) => isReviewableFilePath(c.newPath ?? c.oldPath ?? ""));

    const seeds = new Map();

    for (const path of currentPaths) {
      seeds.set(path, {
        path, worktreeStatus: null, hasWorkingTreeFile: true,
        inGitDiff: false, inLastCommit: false, gitDiff: null, lastCommit: null,
        commitComparisons: {},
      });
    }

    for (const change of worktreeChanges) {
      const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
      const seed = upsertSeed(seeds, key, () => ({
        path: key, worktreeStatus: null,
        hasWorkingTreeFile: change.newPath != null,
        inGitDiff: false, inLastCommit: false, gitDiff: null, lastCommit: null,
        commitComparisons: {},
      }));
      seed.worktreeStatus = change.status;
      seed.hasWorkingTreeFile = change.newPath != null;
      seed.inGitDiff = true;
      seed.gitDiff = toComparison(change);
    }

    for (const change of lastCommitChanges) {
      const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
      const seed = upsertSeed(seeds, key, () => ({
        path: key, worktreeStatus: null,
        hasWorkingTreeFile: change.newPath != null && currentPaths.includes(change.newPath),
        inGitDiff: false, inLastCommit: false, gitDiff: null, lastCommit: null,
        commitComparisons: {},
      }));
      seed.inLastCommit = true;
      seed.lastCommit = toComparison(change);
    }

    for (const [commitSha, changes] of commitChanges) {
      for (const change of changes) {
        const key = change.newPath ?? change.oldPath ?? toDisplayPath(change);
        const seed = upsertSeed(seeds, key, () => ({
          path: key, worktreeStatus: null,
          hasWorkingTreeFile: change.newPath != null && currentPaths.includes(change.newPath),
          inGitDiff: false, inLastCommit: false, gitDiff: null, lastCommit: null,
          commitComparisons: {},
        }));
        seed.commitComparisons[commitSha] = toComparison(change);
      }
    }

    const files = [...seeds.values()].map(createReviewFile).sort(compareReviewFiles);
    return { repoRoot, files, commits };
  }

  /**
   * @param {string} repoRoot
   * @param {object} file
   * @param {"git-diff"|"last-commit"|"commit"|"all-files"} scope
   * @param {{ gitDiffOriginalRef?: string, commitSha?: string }} [options]
   */
  async function loadReviewFileContents(repoRoot, file, scope, options = {}) {
    if (scope === "all-files") {
      const content = file.hasWorkingTreeFile ? await getWorkingTreeContent(repoRoot, file.path) : "";
      return { originalContent: content, modifiedContent: content };
    }

    const comparison = scope === "git-diff"
      ? file.gitDiff
      : scope === "commit" && options.commitSha
        ? file.commitComparisons[options.commitSha]
        : file.lastCommit;
    if (comparison == null) return { originalContent: "", modifiedContent: "" };

    const originalRevision = scope === "git-diff"
      ? (options.gitDiffOriginalRef ?? "HEAD")
      : scope === "commit" && options.commitSha
        ? `${options.commitSha}^`
        : "HEAD^";
    const modifiedRevision = scope === "git-diff"
      ? null
      : scope === "commit" && options.commitSha
        ? options.commitSha
        : "HEAD";

    const originalContent = comparison.oldPath == null
      ? ""
      : await getRevisionContent(repoRoot, originalRevision, comparison.oldPath);
    const modifiedContent = comparison.newPath == null
      ? ""
      : modifiedRevision == null
        ? await getWorkingTreeContent(repoRoot, comparison.newPath)
        : await getRevisionContent(repoRoot, modifiedRevision, comparison.newPath);

    return { originalContent, modifiedContent };
  }

  return {
    getRepoRoot,
    getReviewWindowData,
    loadReviewFileContents,
    resolveBaseRef,
    resolveMergeBase,
  };
}

// Default-exec instance. Re-exported as named functions for back-compat with
// the standalone CLI's existing `import { getReviewWindowData, ... }` style.
const _defaultOps = createGitOps();
export const getRepoRoot = _defaultOps.getRepoRoot;
export const getReviewWindowData = _defaultOps.getReviewWindowData;
export const loadReviewFileContents = _defaultOps.loadReviewFileContents;
export const resolveBaseRef = _defaultOps.resolveBaseRef;
export const resolveMergeBase = _defaultOps.resolveMergeBase;
