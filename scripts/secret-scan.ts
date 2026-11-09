#!/usr/bin/env bun
/**
 * `bun run secrets:scan [--base <ref>]`: fails on a credential in any commit in
 * base..HEAD. Every commit, not the net diff: a key added and later removed
 * still lands in history, and so do commit messages. Uses only the
 * fixed-format rules; the index's keyword and entropy rules are too loose for
 * a gate that review already backs up.
 *
 * Exit codes: 0 clean, 1 findings, 2 could not scan.
 */
import path from "path";
import { parseArgs } from "util";
import { findFormatSecrets } from "../src/index/secrets";

interface Finding {
  commit: string;
  where: string;
  line: number;
  rule: string;
  masked: string;
}

const COMMIT_MESSAGE = "(commit message)";
const CREDENTIAL_FILE = "credential-file";
const SHOWN_PREFIX = 4;

function mask(secret: string): string {
  return `${secret.slice(0, SHOWN_PREFIX)}… (${secret.length} chars)`;
}

export function isCredentialFile(file: string): boolean {
  const name = path.posix.basename(file);
  if (/^\.env(?:\..*)?$/.test(name)) return name !== ".env.example";
  return (
    /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/.test(name)
  );
}

function git(args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString();
}

function scanLine(text: string, commit: string, where: string, line: number): Finding[] {
  return findFormatSecrets(text).map((hit) => ({
    commit,
    where,
    line,
    rule: hit.rule,
    masked: mask(text.slice(hit.start, hit.end)),
  }));
}

const COMMIT_SEPARATOR = "\u0000commit ";

/** Lines each commit adds, parsed from a zero-context patch log. */
export function scanPatchLog(log: string): Finding[] {
  const findings: Finding[] = [];
  let commit = "";
  let file = "";
  let lineNumber = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith(COMMIT_SEPARATOR)) {
      commit = line.slice(COMMIT_SEPARATOR.length);
    } else if (line.startsWith("+++ ")) {
      file = line === "+++ /dev/null" ? "" : line.replace(/^\+\+\+ b\//, "");
    } else if (line.startsWith("@@")) {
      lineNumber = Number(/\+(\d+)/.exec(line)?.[1] ?? 0);
    } else if (line.startsWith("+") && file !== "") {
      findings.push(...scanLine(line.slice(1), commit, file, lineNumber));
      lineNumber++;
    }
  }
  return findings;
}

/** Each commit's full message, scanned line by line. */
export function scanMessageLog(log: string): Finding[] {
  const findings: Finding[] = [];
  for (const record of log.split("\u0000")) {
    const [commit = "", ...message] = record.replace(/^\n/, "").split("\n");
    message.forEach((text, index) => {
      findings.push(...scanLine(text, commit, COMMIT_MESSAGE, index + 1));
    });
  }
  return findings;
}

function scanAddedFiles(range: string): Finding[] {
  const log = git(["log", "--diff-filter=A", "--name-only", "--format=%x00%H", range]);
  const findings: Finding[] = [];
  for (const record of log.split("\u0000")) {
    const [commit = "", ...files] = record.split("\n").filter((l) => l !== "");
    for (const file of files.filter(isCredentialFile)) {
      findings.push({ commit, where: file, line: 0, rule: CREDENTIAL_FILE, masked: "" });
    }
  }
  return findings;
}

function main(): number {
  const { values } = parseArgs({ options: { base: { type: "string", default: "origin/main" } } });
  const range = `${values.base}..HEAD`;
  const patches = git([
    "log",
    "-p",
    "--no-merges",
    "--no-color",
    "--no-ext-diff",
    "--unified=0",
    "--format=%x00commit %H",
    range,
  ]);
  const messages = git(["log", "-z", "--format=%H%n%B", range]);
  const findings = [
    ...scanPatchLog(patches),
    ...scanMessageLog(messages),
    ...scanAddedFiles(range),
  ];
  const commits = git(["rev-list", "--count", range]).trim();

  if (findings.length === 0) {
    console.log(`secrets:scan: ${commits} commit(s) in ${range}, no credentials found`);
    return 0;
  }
  for (const f of findings) {
    const at = f.line > 0 ? `${f.where}:${f.line}` : f.where;
    console.error(`${f.commit.slice(0, 10)} ${at} [${f.rule}] ${f.masked}`);
  }
  console.error(
    `secrets:scan: ${findings.length} finding(s). Rotate any real credential; for a false positive, add "allow-secret <rule>" on the same line.`,
  );
  return 1;
}

if (import.meta.main) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`secrets:scan: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
