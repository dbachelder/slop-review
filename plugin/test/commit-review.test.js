import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getReviewWindowData, loadReviewFileContents } from "../src/git.js";
import { composeReviewPrompt } from "../src/prompt.js";

function runGit({ cwd, args }) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function commitFile({ cwd, path, content, message }) {
  await writeFile(join(cwd, path), content, "utf8");
  runGit({ cwd, args: ["add", "--", path] });
  runGit({ cwd, args: ["commit", "-m", message] });
  return runGit({ cwd, args: ["rev-parse", "HEAD"] });
}

test("indexes recent commits and loads the selected commit contents", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "slop-review-test-"));

  try {
    runGit({ cwd, args: ["init"] });
    runGit({ cwd, args: ["config", "user.name", "Slop Review Test"] });
    runGit({ cwd, args: ["config", "user.email", "slop-review@example.com"] });

    const firstSha = await commitFile({ cwd, path: "alpha.txt", content: "one\n", message: "Add alpha" });
    const secondSha = await commitFile({ cwd, path: "alpha.txt", content: "two\n", message: "Update alpha" });
    await rename(join(cwd, "alpha.txt"), join(cwd, "beta.txt"));
    runGit({ cwd, args: ["add", "-A"] });
    runGit({ cwd, args: ["commit", "-m", "Rename alpha"] });
    const thirdSha = runGit({ cwd, args: ["rev-parse", "HEAD"] });

    const { commits, files } = await getReviewWindowData(cwd);

    assert.deepEqual(commits.map(({ sha, subject }) => ({ sha, subject })), [
      { sha: thirdSha, subject: "Rename alpha" },
      { sha: secondSha, subject: "Update alpha" },
      { sha: firstSha, subject: "Add alpha" },
    ]);

    const renamedFile = files.find((file) => file.commitComparisons[thirdSha]);
    assert.equal(renamedFile.commitComparisons[thirdSha].status, "renamed");
    assert.equal(renamedFile.commitComparisons[thirdSha].displayPath, "alpha.txt -> beta.txt");

    assert.deepEqual(
      await loadReviewFileContents(cwd, renamedFile, "commit", { commitSha: thirdSha }),
      { originalContent: "two\n", modifiedContent: "two\n" },
    );

    const rootFile = files.find((file) => file.commitComparisons[firstSha]);
    assert.deepEqual(
      await loadReviewFileContents(cwd, rootFile, "commit", { commitSha: firstSha }),
      { originalContent: "", modifiedContent: "one\n" },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("identifies selected commits in composed feedback", () => {
  const sha = "1234567890abcdef1234567890abcdef12345678";
  const file = {
    id: "file-id",
    path: "new-name.js",
    gitDiff: null,
    lastCommit: null,
    commitComparisons: {
      [sha]: {
        displayPath: "old-name.js -> new-name.js",
      },
    },
  };

  const prompt = composeReviewPrompt([file], {
    overallComment: "",
    comments: [{
      fileId: file.id,
      scope: "commit",
      commitSha: sha,
      side: "modified",
      startLine: 7,
      endLine: 7,
      body: "Fix this line.",
    }],
  });

  assert.match(prompt, /\[commit 1234567890ab\] old-name\.js -> new-name\.js:7 \(new\)/);
});
