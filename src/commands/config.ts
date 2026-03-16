import path from "path";
import { loadConfig } from "../config";

export async function cmdConfig(repoRoot: string, args: string[]) {
  const config = await loadConfig(repoRoot);

  if (args.length === 0) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  // Parse --key value pairs into an immutable updates object
  const SCORING_KEYS: Record<string, (v: string) => [string, number]> = {
    decay: (v) => ["commitDecay", parseFloat(v)],
    "commit-depth": (v) => ["commitDepth", parseInt(v)],
    alpha: (v) => ["alpha", parseFloat(v)],
    beta: (v) => ["beta", parseFloat(v)],
    gamma: (v) => ["gamma", parseFloat(v)],
    "min-score": (v) => ["minScore", parseFloat(v)],
    "parent-boost-multiplier": (v) => ["parentBoostMultiplier", parseFloat(v)],
  };

  const pairs = Array.from({ length: Math.floor(args.length / 2) }, (_, i) => ({
    key: args[i * 2].replace(/^--/, ""),
    value: args[i * 2 + 1],
  }));

  const updates = pairs.reduce<Record<string, unknown>>((acc, { key, value }) => {
    if (key === "formatter") return { ...acc, formatter: value };
    if (key === "store") return { ...acc, store: value };
    const scoringFn = SCORING_KEYS[key];
    if (scoringFn) {
      const [field, parsed] = scoringFn(value);
      return { ...acc, scoring: { ...((acc.scoring as object) ?? {}), [field]: parsed } };
    }
    return acc;
  }, {});

  const localConfigPath = path.join(repoRoot, ".codeindex.json");
  const existing = await (async () => {
    try {
      return await Bun.file(localConfigPath).json();
    } catch {
      return {};
    }
  })();

  const merged = { ...existing, ...updates };
  await Bun.write(localConfigPath, JSON.stringify(merged, null, 2) + "\n");
  console.log("Config saved to .codeindex.json");
}

export async function cmdConfigList(repoRoot: string) {
  const config = await loadConfig(repoRoot);

  // Pure recursive flatten — returns new array, no mutation
  const flattenConfig = (
    obj: Record<string, unknown>,
    prefix: string,
  ): Array<{ key: string; value: unknown; source: string }> =>
    Object.entries(obj).flatMap(([k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k;
      return v !== null && typeof v === "object" && !Array.isArray(v)
        ? flattenConfig(v as Record<string, unknown>, key)
        : [{ key, value: v, source: "config" }];
    });

  const baseEntries = flattenConfig(config as unknown as Record<string, unknown>, "");

  // Apply env var overrides immutably
  const envOverrides: Record<string, string | undefined> = {
    "pg.host": process.env.PGHOST,
    "pg.port": process.env.PGPORT,
    "pg.database": process.env.PGDATABASE,
    "pg.user": process.env.PGUSER,
  };

  const entries = baseEntries.map((entry) => {
    const envVal = envOverrides[entry.key];
    return envVal !== undefined ? { ...entry, source: "env", value: envVal } : entry;
  });

  // Print as aligned table
  const maxKeyLen = Math.max(...entries.map((e) => e.key.length));
  for (const e of entries) {
    const val = JSON.stringify(e.value);
    console.log(`${e.key.padEnd(maxKeyLen)}  ${val.padEnd(20)}  (${e.source})`);
  }
}
