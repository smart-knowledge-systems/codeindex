export interface SecretScanResult {
  hasSecrets: boolean;
  patterns: string[];
}

const PATTERNS: [string, RegExp][] = [
  ["AWS Access Key", /AKIA[0-9A-Z]{16}/],
  ["GitHub Token", /gh[ps]_[A-Za-z0-9_]{36,}/],
  ["GitHub PAT", /github_pat_[A-Za-z0-9_]{22,}/],
  ["Private Key", /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/],
  [
    "Generic Secret",
    /['"]?[a-zA-Z_]*(?:api[_-]?key|secret|token|password)['"]?\s*[:=]\s*['"]([^'"]{8,})['"]/i,
  ],
  ["Connection String", /(?:postgres|mysql|mongodb|redis):\/\/[^\s]+/],
  ["Slack Bot Token", /xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24,}/],
  ["Slack User Token", /xoxp-[0-9]{10,}-[0-9]{10,}-[0-9]{10,}-[a-f0-9]{32}/],
  ["Google API Key", /AIza[0-9A-Za-z_-]{35}/],
  ["JWT Token", /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/],
  ["Stripe Secret Key", /sk_live_[0-9a-zA-Z]{24,}/],
  ["Twilio API Key", /SK[0-9a-fA-F]{32}/],
  ["SendGrid API Key", /SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{43,}/],
  [
    "Datadog API Key",
    /(DD|dd|datadog)[_-]?(API|api)?[_-]?(KEY|key)\s*[:=]\s*['"]?[0-9a-f]{32}['"]?/,
  ],
];

const BASE64_HEX_RE = /^[A-Za-z0-9+/=\-_]+$/;

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  const len = s.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function hasHighEntropyStrings(content: string): boolean {
  // Match quoted strings and unquoted long tokens that look like base64/hex
  const candidates = content.match(/["'][^"'\s]{20,}["']|(?<=[=:\s])[A-Za-z0-9+/=\-_]{20,}/g);
  if (!candidates) return false;
  for (const raw of candidates) {
    const s = raw.replace(/^["']|["']$/g, "");
    if (s.length > 20 && BASE64_HEX_RE.test(s) && shannonEntropy(s) > 4.5) {
      return true;
    }
  }
  return false;
}

export function scanForSecrets(content: string): SecretScanResult {
  const matched: string[] = [];

  for (const [name, re] of PATTERNS) {
    if (re.test(content)) {
      matched.push(name);
    }
  }

  if (hasHighEntropyStrings(content)) {
    matched.push("High-Entropy String");
  }

  return { hasSecrets: matched.length > 0, patterns: matched };
}
