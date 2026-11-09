import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { isCredentialFile, scanMessageLog, scanPatchLog } from "../scripts/secret-scan";

// Assembled from pieces so this file holds no literal credential.
const AWS = `AKIA${"Z7QRSTUV2345WXYZ"}`;
const SCRIPT = path.join(import.meta.dir, "..", "scripts", "secret-scan.ts");

describe("scanPatchLog", () => {
  const log = [
    "\u0000commit abc123",
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -0,0 +10,3 @@",
    "+const ok = 1;",
    `+const key = "${AWS}";`,
    `+const doc = "${AWS}"; // allow-secret aws-access-key-id`,
    `-const removed = "${AWS}";`,
  ].join("\n");

  test("reports added lines with their file and line, masked", () => {
    expect(scanPatchLog(log)).toEqual([
      {
        commit: "abc123",
        where: "src/a.ts",
        line: 11,
        rule: "aws-access-key-id",
        masked: "AKIA… (20 chars)",
      },
    ]);
  });
});

describe("scanMessageLog", () => {
  test("reports a credential in a commit body", () => {
    const log = `abc123\nfix: rotate key\n\nold one was ${AWS}\n\u0000def456\nclean\n`;
    expect(scanMessageLog(log).map((f) => [f.commit, f.line, f.rule])).toEqual([
      ["abc123", 3, "aws-access-key-id"],
    ]);
  });
});

describe("isCredentialFile", () => {
  test.each([".env", ".env.local", "deploy/server.pem", "id_ed25519", "keystore.jks"])(
    "flags %s",
    (file) => expect(isCredentialFile(file)).toBe(true),
  );
  test.each([".env.example", "src/env.ts", "docs/keys.md"])("passes %s", (file) =>
    expect(isCredentialFile(file)).toBe(false),
  );
});

describe("secrets:scan", () => {
  test("fails on a key added and removed within the range, and passes without it", () => {
    const repo = mkdtempSync(path.join(tmpdir(), "cidx-scan-"));
    const run = (...args: string[]) =>
      Bun.spawnSync(args, {
        cwd: repo,
        env: { PATH: process.env.PATH ?? "", HOME: repo },
      });
    const git = (...args: string[]) =>
      run("git", "-c", "user.name=t", "-c", "user.email=t@t", ...args)
        .stdout.toString()
        .trim();
    try {
      git("init", "-q");
      writeFileSync(path.join(repo, "a.ts"), "export {};\n");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD");

      writeFileSync(path.join(repo, "a.ts"), `export const k = "${AWS}";\n`);
      git("commit", "-q", "-am", "add");
      writeFileSync(path.join(repo, "a.ts"), "export {};\n");
      git("commit", "-q", "-am", "remove");

      expect(run("bun", SCRIPT, "--base", base).exitCode).toBe(1);
      expect(run("bun", SCRIPT, "--base", "HEAD").exitCode).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
