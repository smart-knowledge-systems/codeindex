import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { getChangedFiles, getFileCommits } from "../src/index/commits";
import { getCommitMessage } from "../src/commands/helpers";
import { installHook } from "../src/hooks/post-commit";

let repo: string;

function git(...args: string[]): string {
  const proc = Bun.spawnSync(
    ["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { env: { PATH: process.env.PATH ?? "", HOME: repo } },
  );
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "cidx-hook-"));
  git("init", "-q");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("getChangedFiles", () => {
  it("lists the files of a root commit, including awkward names", async () => {
    const names = ["a,b.ts", "f g.ts", "café.ts"];
    for (const name of names) writeFileSync(path.join(repo, name), "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "root");

    const files = await getChangedFiles(repo, git("rev-parse", "HEAD"));
    expect(files.sort()).toEqual([...names].sort());
  });
});

describe("commit messages", () => {
  it("are redacted where they are read from git", async () => {
    const key = `AKIA${"Z7QRSTUV2345WXYZ"}`;
    writeFileSync(path.join(repo, "a.ts"), "x\n");
    git("add", ".");
    git("commit", "-q", "-m", `rotate key, old one was ${key}`);

    const [entry] = await getFileCommits(repo, "a.ts", 1);
    expect(entry?.message).toBe("rotate key, old one was [REDACTED]");
    expect(await getCommitMessage(repo, git("rev-parse", "HEAD"))).toBe(
      "rotate key, old one was [REDACTED]",
    );
  });
});

describe("installHook", () => {
  const legacyBodies = [
    `# codeindex hook
files=$(git diff-tree --no-commit-id --name-only -r HEAD)
commit=$(git rev-parse HEAD)
codeindex update --files $files --commit $commit`,
    `# codeindex hook
files=$(git diff-tree --no-commit-id --name-only -r HEAD | paste -sd, -)
commit=$(git rev-parse HEAD)
if [ -n "$files" ]; then codeindex update --files "$files" --commit "$commit"; fi`,
  ];

  for (const [i, body] of legacyBodies.entries()) {
    it(`upgrades legacy body ${i + 1} in place and keeps the user's lines`, async () => {
      const hookPath = path.join(repo, ".git", "hooks", "post-commit");
      writeFileSync(hookPath, `#!/bin/sh\necho before\n${body}\necho after\n`);

      expect((await installHook(repo)).action).toBe("upgraded");
      const upgraded = readFileSync(hookPath, "utf8");
      expect(upgraded).toContain('codeindex update --commit "$(git rev-parse HEAD)"');
      expect(upgraded).not.toContain("--files");
      expect(upgraded).toContain("echo before");
      expect(upgraded).toContain("echo after");

      expect((await installHook(repo)).action).toBe("skipped");
    });
  }
});
