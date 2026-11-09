import { describe, expect, test } from "bun:test";
import { findFormatSecrets, redactSecrets, scanForSecrets } from "../src/index/secrets";

// Samples are assembled from pieces so this file holds no literal credential
// for a scanner to flag.
const HEX = "0123456789abcdef";
const ALNUM36 = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"; // allow-secret high-entropy
const AWS = `AKIA${"Z7QRSTUV2345WXYZ"}`;
const PEM_HEADER = `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`;

const rulesFor = (text: string) => scanForSecrets(text).patterns;

describe("format rules", () => {
  test.each([
    ["aws-access-key-id", `key = "${AWS}"`],
    ["github-token", `gh${"o_"}${ALNUM36}`],
    ["private-key", PEM_HEADER],
    ["anthropic", `sk-ant-${"api03"}-${"Ab3_".repeat(21)}`],
    ["openai", `sk-proj-${"Ab3".repeat(8)}T3Blb${"kFJ"}${"Cd4".repeat(8)}`],
    ["url-password", `postgresql://admin:${"hunter2x"}@db.internal:5432/app`],
    ["url-password", `mongodb+srv://u:${"pa55word"}@cluster0.example.net`],
    ["url-password", `https://deploy:${"t0ken"}@git.example.com/repo.git`],
  ])("%s: %s", (rule, sample) => {
    expect(rulesFor(sample)).toContain(rule);
  });

  test("leaves AWS's documented example key alone", () => {
    expect(rulesFor("aws_access_key_id = AKIAIOSFODNN7EXAMPLE")).toEqual([]);
  });

  test("leaves a connection string without a password alone", () => {
    expect(rulesFor("DATABASE_URL=postgres://localhost/dev")).toEqual([]);
    expect(rulesFor("redis://:${PASSWORD}@cache")).toEqual([]);
    expect(rulesFor("postgresql://user:password@host:5432/db")).toEqual([]);
  });
});

describe("keyword rules", () => {
  test.each([
    ["keyword-assignment", `PASSWORD=${"Tr0ub4dor"}Xhorse`],
    ["keyword-assignment", `password: "${"Tr0ub4dor"}&3"`],
    ["keyword-assignment", `HEROKU_API_KEY=${HEX.slice(0, 8)}-1a2b-3c4d-5e6f-${HEX.slice(0, 12)}`],
    ["bearer-token", `curl -H 'Authorization: Bearer ${"a1b2c3d4"}e5f6g7h8'`],
  ])("%s: %s", (rule, sample) => {
    expect(rulesFor(sample)).toContain(rule);
  });

  test("leaves passphrases, references and placeholders alone", () => {
    expect(rulesFor('const password = "correct-horse-battery"')).toEqual([]);
    expect(rulesFor("token = this.session.token")).toEqual([]);
    expect(rulesFor("apiKey: ${API_KEY}")).toEqual([]);
    expect(rulesFor("Authorization: Bearer <your-token-here>")).toEqual([]);
    expect(rulesFor("maxTokens: 4096")).toEqual([]);
    expect(rulesFor("readonly secretKey: Uint8Array")).toEqual([]);
    expect(rulesFor("const derive = (rootSecretMaterial: Uint8Array) => {}")).toEqual([]);
    expect(rulesFor("const apiKey = apiKeyV2;")).toEqual([]);
  });
});

describe("allow-secret marker", () => {
  test("exempts only the rule it names, on its own line", () => {
    expect(rulesFor(`"${AWS}" // allow-secret aws-access-key-id`)).toEqual([]);
    expect(rulesFor(`"${AWS}" // allow-secret github-token`)).toContain("aws-access-key-id");
    expect(rulesFor(`// allow-secret aws-access-key-id\n"${AWS}"`)).toContain("aws-access-key-id");
  });

  test("cannot exempt a private key", () => {
    expect(rulesFor(`${PEM_HEADER} # allow-secret private-key`)).toContain("private-key");
  });
});

describe("findFormatSecrets", () => {
  test("ignores keyword and entropy rules", () => {
    expect(findFormatSecrets(`PASSWORD=${"Tr0ub4dor"}Xhorse`)).toEqual([]);
    expect(findFormatSecrets(`"${ALNUM36}${ALNUM36}"`)).toEqual([]);
  });
});

describe("redactSecrets", () => {
  test("replaces only the credential", () => {
    const message = `rotate key, old one was ${AWS}; see runbook`;
    expect(redactSecrets(message)).toBe("rotate key, old one was [REDACTED]; see runbook");
  });

  test("returns clean text unchanged", () => {
    const message = "fix(search): keep file results in searchChanged";
    expect(redactSecrets(message)).toBe(message);
  });
});
