import path from "path";
import { loadConfig, globalConfigExists, writeGlobalConfig, getGlobalConfigPath } from "./config";
import { pgServerReachable, pgDatabaseExists, bootstrapPostgres } from "./setup/database";
import { discoverRepos, type DiscoveredRepo } from "./setup/discover";
import { generateIndexIgnore, writeIndexIgnore } from "./setup/indexignore";
import { repoAddBulk } from "./repo";
import { logEvent } from "./logging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SetupOptions {
  scanDir?: string;
  single?: boolean;
  yes?: boolean;
  store?: "pg" | "sqlite";
  skipDoctor?: boolean;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Console output helpers — human-readable CLI output (not logging)
// ---------------------------------------------------------------------------

function ok(label: string) {
  process.stdout.write(`[ok] ${label}\n`);
}

function fail(label: string, hint?: string) {
  process.stderr.write(`[!!] ${label}\n`);
  if (hint) process.stderr.write(`     ${hint}\n`);
}

function info(msg: string) {
  process.stdout.write(`     ${msg}\n`);
}

// ---------------------------------------------------------------------------
// cmdSetup
// ---------------------------------------------------------------------------

export async function cmdSetup(repoRoot: string, opts: SetupOptions): Promise<void> {
  const isMultiRepo = !!opts.scanDir;

  info("");
  info("  codeindex setup");
  info(`  ${isMultiRepo ? "Multi-repo PostgreSQL" : "Single-repo"} setup`);
  info("");

  // -----------------------------------------------------------------------
  // Step 1: Environment Detection
  // -----------------------------------------------------------------------
  info("Step 1/7: Environment Detection");

  const config = await loadConfig(repoRoot);
  const storeType = opts.store ?? config.store;

  if (storeType === "pg") {
    const { host, port, user, database } = config.pg;
    const reachable = await pgServerReachable(host, port, user);
    if (reachable) {
      ok(`PostgreSQL server reachable (${host}:${port})`);
    } else {
      fail(`PostgreSQL server unreachable (${host}:${port})`, "Ensure PostgreSQL is running.");
      process.exit(1);
    }

    if (process.env.OPENAI_API_KEY) {
      ok("OPENAI_API_KEY set");
    } else {
      fail(
        "OPENAI_API_KEY not set",
        "Required for embeddings. Set OPENAI_API_KEY or CODEINDEX_OPENAI_API_KEY in ~/.config/codeindex/.env",
      );
      process.exit(1);
    }

    const dbExists = await pgDatabaseExists(host, port, user, database);
    if (dbExists) {
      ok(`Database "${database}" exists`);
    } else {
      fail(`Database "${database}" does not exist`);
    }
  } else {
    ok("Store: sqlite");
    if (process.env.OPENAI_API_KEY) {
      ok("OPENAI_API_KEY set");
    } else {
      fail(
        "OPENAI_API_KEY not set",
        "Required for embeddings. Set OPENAI_API_KEY or CODEINDEX_OPENAI_API_KEY in ~/.config/codeindex/.env",
      );
      process.exit(1);
    }
  }

  info("");

  // -----------------------------------------------------------------------
  // Step 2: Database Bootstrap
  // -----------------------------------------------------------------------
  info("Step 2/7: Database Bootstrap");

  if (storeType === "pg") {
    if (opts.dryRun) {
      info("(dry run) Would create database, install pgvector, run migrations");
    } else {
      try {
        const result = await bootstrapPostgres();
        if (result.error) {
          fail(result.error);
          process.exit(1);
        }
        if (result.databaseCreated) {
          ok(`Database "${config.pg.database}" created`);
        }
        if (result.extensionInstalled) {
          ok("pgvector extension installed");
        }
        if (result.migrationsApplied.length > 0) {
          ok(
            `Applied ${result.migrationsApplied.length} migration(s): ${result.migrationsApplied.join(", ")}`,
          );
        } else {
          ok("Schema up to date");
        }
      } catch (err) {
        fail(`Database bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }
  } else {
    ok("SQLite — no database setup needed");
  }

  info("");

  // -----------------------------------------------------------------------
  // Step 3: Global Config
  // -----------------------------------------------------------------------
  info("Step 3/7: Global Config");

  const hasGlobal = await globalConfigExists();
  if (hasGlobal) {
    ok(`Global config exists at ${getGlobalConfigPath()}`);
  } else if (opts.dryRun) {
    info("(dry run) Would create global config");
  } else {
    const globalCfg: Record<string, unknown> = { store: storeType };
    if (storeType === "pg") {
      globalCfg.pg = {
        host: config.pg.host,
        port: config.pg.port,
        database: config.pg.database,
      };
    }
    const cfgPath = await writeGlobalConfig(globalCfg);
    ok(`Created ${cfgPath}`);
  }

  info("");

  // -----------------------------------------------------------------------
  // Step 4: Repository Discovery
  // -----------------------------------------------------------------------
  info("Step 4/7: Repository Discovery");

  let repos: DiscoveredRepo[];

  if (isMultiRepo) {
    const scanDir = path.resolve(opts.scanDir!);
    info(`Scanning ${scanDir} for git repositories...`);
    repos = await discoverRepos(scanDir);

    if (repos.length === 0) {
      fail("No git repositories found");
      process.exit(1);
    }

    ok(`Found ${repos.length} repositories`);

    // Print list
    for (let i = 0; i < repos.length; i++) {
      const r = repos[i];
      const num = String(i + 1).padStart(3);
      const files = r.estimatedFileCount > 0 ? `(${r.estimatedFileCount} files)` : "";
      info(`${num}. ${r.name.padEnd(30)} ${files}`);
    }
  } else {
    // Single-repo mode: just the current directory
    const { existsSync } = await import("fs");
    const gitHead = path.join(repoRoot, ".git", "HEAD");
    if (!existsSync(gitHead)) {
      fail("Not a git repository", "Run `git init` first.");
      process.exit(1);
    }
    repos = [
      {
        absPath: repoRoot,
        name: path.basename(repoRoot),
        hasGit: true,
        hasIndexIgnore: existsSync(path.join(repoRoot, ".indexignore")),
        estimatedFileCount: 0,
      },
    ];
    ok(`Repository: ${repos[0].name}`);
  }

  info("");

  // -----------------------------------------------------------------------
  // Step 5: Repository Registration
  // -----------------------------------------------------------------------
  info("Step 5/7: Repository Registration");

  if (opts.dryRun) {
    info(`(dry run) Would register ${repos.length} repositories`);
  } else {
    const results = await repoAddBulk(
      repoRoot,
      repos.map((r) => r.absPath),
    );
    const added = results.filter((r) => r.status === "added").length;
    const exists = results.filter((r) => r.status === "exists").length;
    const errors = results.filter((r) => r.status === "error");

    if (added > 0 || exists > 0) {
      ok(`${added} added, ${exists} already registered`);
    }
    for (const e of errors) {
      fail(`${e.name}: ${e.error}`);
    }
  }

  info("");

  // -----------------------------------------------------------------------
  // Step 6: .indexignore Generation
  // -----------------------------------------------------------------------
  info("Step 6/7: .indexignore Generation");

  let created = 0;
  let skipped = 0;

  for (const repo of repos) {
    if (opts.dryRun) {
      if (repo.hasIndexIgnore) {
        skipped++;
      } else {
        created++;
      }
      continue;
    }

    if (repo.hasIndexIgnore) {
      skipped++;
      continue;
    }

    try {
      const patterns = await generateIndexIgnore(repo.absPath);
      const written = await writeIndexIgnore(repo.absPath, patterns);
      if (written) {
        created++;
      } else {
        skipped++;
      }
    } catch {
      fail(`${repo.name}: failed to generate .indexignore`);
    }
  }

  if (opts.dryRun) {
    info(`(dry run) Would create ${created}, skip ${skipped} existing`);
  } else {
    ok(`${created} created, ${skipped} already existed`);
  }

  info("");

  // -----------------------------------------------------------------------
  // Step 7: Next Steps
  // -----------------------------------------------------------------------
  info("Step 7/7: Next Steps");

  const totalFiles = repos.reduce((s, r) => s + r.estimatedFileCount, 0);
  if (totalFiles > 0) {
    info(`Total files: ~${totalFiles.toLocaleString()}`);
  }

  info("");
  if (isMultiRepo) {
    info("Run: codeindex reindex --scope all --workers 4");
  } else {
    info("Run: codeindex reindex");
  }

  info("");
  info("Setup complete!");
  info("");

  logEvent({
    event: "infra.setup.complete",
    storeType,
    isMultiRepo,
    repoCount: repos.length,
    totalFiles,
    dryRun: !!opts.dryRun,
  });
}
