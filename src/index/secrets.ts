export interface SecretScanResult {
  hasSecrets: boolean;
  /** Ids of the rules that matched, each once. */
  patterns: string[];
}

export interface SecretRule {
  readonly id: string;
  readonly patterns: readonly RegExp[];
  /** Exact matches that are published examples, not credentials. */
  readonly examples?: readonly string[];
  /** Rejects a match that has the rule's shape but is not a credential. */
  readonly accept?: (match: RegExpMatchArray) => boolean;
}

export interface SecretHit {
  readonly rule: string;
  readonly start: number;
  readonly end: number;
}

/** Fixed-prefix credential formats: precise enough to gate commits on. */
export const FORMAT_RULES: readonly SecretRule[] = [
  {
    id: "aws-access-key-id",
    patterns: [/\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g],
    examples: ["AKIAIOSFODNN7EXAMPLE"],
  },
  {
    id: "aws-secret-access-key",
    patterns: [
      /(?<![A-Za-z0-9])aws_?secret_?access_?key["']?\s*[:=]\s*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/gi,
    ],
  },
  {
    id: "github-token",
    patterns: [/\b(?:ghp|gho|ghu|ghs|ghr)_[0-9a-zA-Z]{36}\b/g, /\bgithub_pat_\w{82}\b/g],
  },
  { id: "gitlab-pat", patterns: [/(?<![A-Za-z0-9])glpat-[\w-]{20,}/g] },
  {
    id: "private-key",
    patterns: [/-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g],
  },
  {
    id: "slack",
    patterns: [
      /\bxox[baprs]-[0-9]{10,13}-/g,
      /hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/g,
      /\bxapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+/gi,
      /\bxoxe\.xox[bp]-\d-[A-Z0-9]{100,}/gi,
      /\bxoxe-\d-[A-Z0-9]{100,}/gi,
    ],
  },
  { id: "stripe-live", patterns: [/\b(?:sk|rk)_(?:live|prod)_[a-zA-Z0-9]{10,99}\b/g] },
  { id: "stripe-webhook", patterns: [/\bwhsec_[a-zA-Z0-9]{32,}\b/g] },
  { id: "twilio-api-key", patterns: [/\bSK[0-9a-fA-F]{32}\b/g] },
  {
    id: "cloudflare",
    patterns: [
      /\bcf(?:k|ut|at)_[\w-]{40,}/g,
      /(?<![A-Za-z0-9])(?:CLOUDFLARE|CF)_?[A-Z_]*(?:TOKEN|KEY)["']?\s*[:=]\s*["']?(?:[\w-]{40}|[a-f0-9]{37,45})(?![\w-])/gi,
    ],
  },
  { id: "anthropic", patterns: [/\bsk-ant-(?:api|admin)\d\d-[\w-]{80,}/g] },
  { id: "openai", patterns: [/\bsk-(?:proj-|svcacct-|admin-)?[\w-]{20,}T3BlbkFJ[\w-]{20,}/g] },
  { id: "gcp-api-key", patterns: [/\bAIza[\w-]{35}\b/g] },
  { id: "npm", patterns: [/\bnpm_[a-zA-Z0-9]{36}\b/g] },
  { id: "npm-auth-token", patterns: [/_authToken\s*=\s*["']?[^\s$"'`][^\s"'`]*/g] },
  { id: "sendgrid", patterns: [/\bSG\.[\w-]{22}\.[\w-]{43}\b/g] },
  {
    id: "url-password",
    patterns: [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"'`]*:([^\s:/@"'`$<*][^\s:/@"'`]*)@[^\s/"'`]+/gi],
    accept: (match) => !PLACEHOLDER_PASSWORD.test(match[1] ?? ""),
  },
];

// Documentation spells out the shape of a URL with these in the password slot.
const PLACEHOLDER_PASSWORD = /^(?:password|passwd|pass|pwd|secret|changeme|example|x+)$/i;

const MEMBER_EXPRESSION = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

// A value worth flagging mixes letters and digits and is not a reference to
// another value: `password = "correct-horse-battery"` in a fixture, `token =
// this.token` and `key: ${API_KEY}` are ordinary code.
function looksLikeCredential(value: string): boolean {
  return (
    /[A-Za-z]/.test(value) &&
    /\d/.test(value) &&
    !/[$<>{}()[\]]/.test(value) &&
    !MEMBER_EXPRESSION.test(value)
  );
}

/**
 * Credentials found by what labels them rather than by their format. Too loose
 * for a commit gate, but anything indexed is sent to embedding and LLM
 * providers, so a false positive costing one file beats a leak.
 */
export const KEYWORD_RULES: readonly SecretRule[] = [
  {
    id: "keyword-assignment",
    patterns: [
      /(?<![\w-])([\w-]*(?:access[_-]?token|api[_-]?key|auth[_-]?token|client[_-]?secret|credential|passw(?:or)?d|secret|token))["']?\s*([:=])\s*(["'`]?)([^\s"'`,;]{8,})/gi,
    ],
    accept: ([, key = "", separator, quote, value = ""]) => {
      if (!looksLikeCredential(value)) return false;
      if (quote !== "" || !/^[\w$]+$/.test(value)) return true;
      // A bare identifier is a type annotation or a variable in code, and a
      // value only in an env-style assignment such as `API_TOKEN=<value>`.
      return separator === "=" && /^[A-Z0-9_]+$/.test(key);
    },
  },
  {
    id: "bearer-token",
    patterns: [/\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/-]{16,}=*)/g],
    accept: (match) => looksLikeCredential(match[1] ?? ""),
  },
];

const HIGH_ENTROPY = "high-entropy";
const ENTROPY_CANDIDATE = /["'][^"'\s]{20,}["']|(?<=[=:\s])[A-Za-z0-9+/=\-_]{20,}/g;
const BASE64_HEX_RE = /^[A-Za-z0-9+/=\-_]+$/;
const ENTROPY_THRESHOLD = 4.5;

/** A rule `allow-secret` cannot exempt: a key is never a false positive. */
const UNMARKABLE = "private-key";
export const ALLOW_MARKER = "allow-secret";

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? text.length : end);
}

function isMarkedAllowed(text: string, index: number, rule: string): boolean {
  if (rule === UNMARKABLE) return false;
  const marker = new RegExp(`${ALLOW_MARKER}\\s+([\\w-]+)`, "g");
  return [...lineAt(text, index).matchAll(marker)].some((m) => m[1] === rule);
}

function ruleHits(text: string, rules: readonly SecretRule[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      for (const match of text.matchAll(pattern)) {
        if (rule.examples?.includes(match[0]) === true) continue;
        if (rule.accept && !rule.accept(match)) continue;
        if (isMarkedAllowed(text, match.index, rule.id)) continue;
        hits.push({ rule: rule.id, start: match.index, end: match.index + match[0].length });
      }
    }
  }
  return hits;
}

function entropyHits(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const match of text.matchAll(ENTROPY_CANDIDATE)) {
    const quoted = /^["']/.test(match[0]);
    const value = quoted ? match[0].slice(1, -1) : match[0];
    if (value.length <= 20 || !BASE64_HEX_RE.test(value)) continue;
    if (shannonEntropy(value) <= ENTROPY_THRESHOLD) continue;
    if (isMarkedAllowed(text, match.index, HIGH_ENTROPY)) continue;
    const start = match.index + (quoted ? 1 : 0);
    hits.push({ rule: HIGH_ENTROPY, start, end: start + value.length });
  }
  return hits;
}

/** Every credential-shaped span in `text` that no example list or marker exempts. */
export function findSecrets(text: string): SecretHit[] {
  return [...ruleHits(text, FORMAT_RULES), ...ruleHits(text, KEYWORD_RULES), ...entropyHits(text)];
}

/** Format rules only, for scanning commits where review backs the scanner up. */
export function findFormatSecrets(text: string): SecretHit[] {
  return ruleHits(text, FORMAT_RULES);
}

export function scanForSecrets(content: string): SecretScanResult {
  const patterns = [...new Set(findSecrets(content).map((hit) => hit.rule))];
  return { hasSecrets: patterns.length > 0, patterns };
}

export const REDACTED = "[REDACTED]";

/** `text` with every span `findSecrets` reports replaced by `[REDACTED]`. */
export function redactSecrets(text: string): string {
  const hits = findSecrets(text).sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const hit of hits) {
    if (hit.end <= cursor) continue;
    out += text.slice(cursor, Math.max(cursor, hit.start)) + REDACTED;
    cursor = hit.end;
  }
  return out + text.slice(cursor);
}
