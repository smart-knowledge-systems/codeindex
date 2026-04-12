#!/usr/bin/env bun

import { loadGlobalEnv } from "./env";
loadGlobalEnv();

import path from "path";
import { parseArgs, flag, hasFlag, warnUnknownFlags } from "./cli";
import { loadConfig } from "./config";
import { closePg } from "./db/pg";
import { closeSqlite } from "./db/sqlite";
import { installHook } from "./hooks/post-commit";
import { generateIntent } from "./intent";
import { detectDrift } from "./drift";
import {
  repoAdd,
  repoRemove,
  repoList,
  repoGetAll,
  repoGetByName,
  repoStatus,
  repoPurge,
} from "./repo";
import { parallelReindex } from "./index/parallel";
import { runHealthCheck } from "./check/runner";
import { runQualityCheck } from "./check/quality-runner";
import { discoverCrossRepoEdges } from "./index/cross-repo";
import { createToken, listTokens, revokeToken } from "./auth/tokens";
import { xrefSymbol, formatXrefTable, formatXrefJson } from "./xref";
import { formatError } from "./errors";

// Command imports
import { cmdInit } from "./commands/init";
import { cmdReindex } from "./commands/reindex";
import { cmdUpdate } from "./commands/update";
import { cmdSearch } from "./commands/search";
import { cmdExport } from "./commands/export";
import { cmdStatus } from "./commands/status";
import { cmdTelemetry } from "./commands/telemetry";
import { cmdManifest } from "./commands/manifest";
import { cmdConfig, cmdConfigList } from "./commands/config";
import { cmdDoctor } from "./commands/doctor";
import { cmdGraph } from "./commands/graph";
import { cmdMcpConfig } from "./commands/mcp-config";
import { cmdDedupStats, cmdDedupGc } from "./commands/dedup";
import { cmdPrune } from "./commands/prune";

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

const HELP_TEXT = `codeindex — semantic code search

Commands:
  setup                Guided setup: database, repos, .indexignore, all in one
    --scan <dir>       Scan directory for git repos (multi-repo mode)
    --yes              Non-interactive, accept all defaults
    --store <type>     Force store type: pg | sqlite
    --dry-run          Show what would happen
  init                 Initialize codeindex in current repo
  reindex              Full reindex of current repo
    --dry-run          Report what would change and projected cost
    --budget <usd>     Set cost cap for this reindex (USD)
    --scope all        Reindex all registered repos in parallel
    --workers <n>      Number of parallel workers (default 3, with --scope all)
  update               Incremental update (called by hook)
    --files <paths>    Files to re-index
    --commit <hash>    Commit to embed and link
  search <query>       Semantic search
    --min-score <f>    Minimum score (default 0.3)
    --top-n <n>        Max results
    --scope <s>        project|all|name1,name2
    --lang <l>         Filter by language (ts,python,rust,go,java,c,cpp,cs)
    --dir <d>          Filter by directory prefix (src/api,lib)
    --since <t>        Filter by time (30d, 2w, 3m, or ISO date)
    --include-skeleton Include skeleton text
    --include-summary  Include directory summaries
    --include-snippet  Include code snippets with line numbers
    --explain          Show per-result score breakdown
    --format <f>       Output format: json (default), pretty, compact
    --pretty           Alias for --format pretty
    --json             Alias for --format json
  intent               Generate AGENTS.md from directory summaries
    --out <path>       Output path (default: stdout)
  drift                Detect stale Intent Nodes in AGENTS.md
    --threshold <f>    Drift threshold (default 0.3)
    --agents-md <path> Path to AGENTS.md (default: AGENTS.md)
    --out <path>       Output JSON path (default: stdout)
  repo <sub>           Manage repositories (add|remove|list|status|purge)
  export               Export pg to sqlite
    --out <path>       Output path (default .codeindex.db)
    --include-embeddings  Include embedding vectors (redacted by default)
    --redact-commits   Exclude commit data from export
    --exclude <globs>  Comma-separated glob patterns to exclude files
  install-hook         Install post-commit git hook
  config               Show/set configuration
  manifest             Audit trail: indexed files, skipped files, secret flags
  status               Show index stats
    --cost             Show token usage and cost breakdown
  serve                Start MCP server for AI agent integration
    --transport <t>    stdio (default) or sse
    --port <n>         Port for SSE transport (default 3100)
  check                Run health policy checks against the index
    --json             Output as JSON
  token <sub>           Manage access tokens (create|list|revoke)
    create --name --repos <id,id> [--expires <ISO>]
    list               List all tokens
    revoke --id <N>    Revoke a token
  mcp-config           Print MCP integration JSON config
    --transport <t>    stdio (default) or sse
    --port <n>         Port for SSE transport (default 3100)
  graph                Visualize cross-repo dependency graph
    --format <f>       json|mermaid|dot (default: mermaid)
  xref <symbol>        Cross-reference a symbol across repos
    --format <f>       json|table (default: table)
  auth                 Configure embedding provider credentials
  doctor               Check environment and configuration
  cloud <sub>          Cloud platform commands
    login              Authenticate with cidx cloud
    logout             Revoke token and sign out
    status             Show account info, repos, and usage
    reindex            Collect and upload index to cloud
    search <query>     Search across cloud-indexed repos
    migrate            Upload local index to cloud
    mcp-config         Print cloud MCP integration config
    sharing <sub>      Manage per-repo sharing (enable|disable|list)
  resolve <url> <commit> <path>  Resolve file content from git address
    --json             Output as JSON
    --strategy <n>     Force resolution strategy (1-5)
  cache <sub>          Manage git clone cache
    list               Show cached repos
    clear              Evict cached repos
  prune                Remove orphaned rows (dead repos, dangling FKs)
    --dry-run          Show what would be deleted without deleting
    --json             Emit machine-readable JSON
  dedup <sub>          Manage the global dedup store
    stats              Show blob/package counts and breakdowns
      --json           Emit machine-readable JSON
    gc                 Sweep unreferenced blobs and orphaned packages
      --dry-run        Compute the plan without deleting
      --json           Emit machine-readable JSON

Options:
  --path <dir>         Repo root (default: cwd)
  --read-only          Block write operations (init, reindex, update)
  --version            Print version
  --llm                Print llm.txt-style usage doc for agents`;

const WRITE_COMMANDS = new Set(["init", "reindex", "update", "install-hook"]);

const SUBCOMMAND_HELP: Record<string, string> = {
  search:
    "Usage: codeindex search <query> [options]\n\nOptions:\n  --min-score <f>       Minimum score threshold (default 0.3)\n  --top-n <n>           Max results\n  --scope <s>           project|all|name1,name2\n  --lang <l>            Filter by language (ts,python,rust,go,java,c,cpp,cs)\n  --dir <d>             Filter by directory prefix\n  --since <t>           Filter by time (30d, 2w, 3m, or ISO date)\n  --include-skeleton    Include skeleton text\n  --include-summary     Include directory summaries\n  --include-snippet     Include code snippets with line numbers\n  --explain             Show per-result score breakdown\n  --format <f>          Output format: json (default), pretty, compact\n  --pretty              Alias for --format pretty\n  --json                Alias for --format json",
  reindex:
    "Usage: codeindex reindex [options]\n\nOptions:\n  --dry-run             Report what would change and projected cost\n  --budget <usd>        Set cost cap for this reindex (USD)\n  --scope all           Reindex all registered repos in parallel\n  --workers <n>         Number of parallel workers (default 3)\n  --force               Force full reindex even if unchanged",
  status:
    "Usage: codeindex status [options]\n\nOptions:\n  --cost                Show token usage and cost breakdown",
  serve:
    "Usage: codeindex serve [options]\n\nOptions:\n  --transport <t>       stdio (default) or sse\n  --port <n>            Port for SSE transport (default 3100)",
  init: "Usage: codeindex init\n\nInitializes codeindex in the current repository.",
  auth: "Usage: codeindex auth\n\nInteractively configure embedding provider credentials.\nSupported providers: OpenAI, Ollama.\nCredentials are stored in ~/.config/codeindex/.env",
  doctor: "Usage: codeindex doctor\n\nChecks environment and configuration health.",
  check:
    "Usage: codeindex check [options]\n\nOptions:\n  --json                Output as JSON\n  --quality             Run quality checks\n  --dataset <path>      Quality dataset path\n  --baseline <path>     Quality baseline path",
  intent:
    "Usage: codeindex intent [options]\n\nOptions:\n  --out <path>          Output path (default: stdout)",
  drift:
    "Usage: codeindex drift [options]\n\nOptions:\n  --threshold <f>       Drift threshold (default 0.3)\n  --agents-md <path>    Path to AGENTS.md (default: AGENTS.md)\n  --out <path>          Output JSON path (default: stdout)",
  repo: "Usage: codeindex repo <add|remove|list|status|purge>\n\nSubcommands:\n  add <path>            Register a repository\n  remove <name>         Unregister a repository\n  list                  List all registered repos\n  status [name]         Show repo status\n  purge <name> [--force] Remove repo and all its data",
  token:
    "Usage: codeindex token <create|list|revoke>\n\nSubcommands:\n  create --name <name> --repos <id,id> [--expires <ISO>]\n  list                  List all tokens\n  revoke --id <N>       Revoke a token",
  graph:
    "Usage: codeindex graph [options]\n\nOptions:\n  --format <f>          Output format: mermaid (default), json, dot",
  xref: "Usage: codeindex xref <symbol> [options]\n\nOptions:\n  --format <f>          Output format: table (default), json",
  "mcp-config":
    "Usage: codeindex mcp-config [options]\n\nOptions:\n  --transport <t>       stdio (default) or sse\n  --port <n>            Port for SSE transport (default 3100)",
  config:
    "Usage: codeindex config [--list | --key value ...]\n\nOptions:\n  --list                Show all config values with sources",
  export:
    "Usage: codeindex export [options]\n\nOptions:\n  --out <path>              Output path (default .codeindex.db)\n  --include-embeddings      Include embedding vectors (redacted by default)\n  --redact-commits          Exclude commit data from export\n  --exclude <globs>         Comma-separated glob patterns to exclude files",
  prune:
    "Usage: codeindex prune [options]\n\nRemove orphaned rows from the index: dead repos (root_path missing\nfrom disk), and dangling files/commits/directories that reference\nnon-existent repos.\n\nOptions:\n  --dry-run             Show what would be deleted without deleting\n  --json                Emit machine-readable JSON",
};

async function main() {
  const parsed = parseArgs(process.argv);
  const repoRoot = flag(parsed, "path") ? path.resolve(flag(parsed, "path")!) : process.cwd();

  // --version: print version and exit
  if (hasFlag(parsed, "version")) {
    const pkg = await Bun.file(path.join(import.meta.dir, "../package.json")).json();
    console.log(pkg.version);
    process.exit(0);
  }

  // --llm: print llm.txt-style usage doc and exit
  if (hasFlag(parsed, "llm") || parsed.command === "--llm") {
    const llmDoc = await Bun.file(path.join(import.meta.dir, "../llm.txt")).text();
    process.stdout.write(llmDoc);
    process.exit(0);
  }

  // Per-subcommand --help
  if (hasFlag(parsed, "help") && parsed.command && SUBCOMMAND_HELP[parsed.command]) {
    console.log(SUBCOMMAND_HELP[parsed.command]);
    process.exit(0);
  }

  // Read-only guard: block write operations when --read-only flag or config is set
  if (WRITE_COMMANDS.has(parsed.command)) {
    const isReadOnlyFlag = hasFlag(parsed, "read-only");
    let isReadOnlyConfig = false;
    try {
      const cfg = await loadConfig(repoRoot);
      isReadOnlyConfig = cfg.readOnly === true;
    } catch {
      // config may not exist yet (e.g. during init)
    }
    if (isReadOnlyFlag || isReadOnlyConfig) {
      console.error(
        `Error: write operation "${parsed.command}" is blocked in read-only mode.\n` +
          "Read-only mode is intended for CI/CD environments where the index should not be modified.\n" +
          "Remove --read-only flag or set readOnly: false in .codeindex.json to allow writes.",
      );
      process.exit(1);
    }
  }

  // Warn about unrecognized flags
  const GLOBAL_FLAGS = [
    "help",
    "version",
    "llm",
    "read-only",
    "json",
    "pretty",
    "explain",
    "min-score",
    "top-n",
    "lang",
    "dir",
    "since",
    "format",
    "scope",
    "out",
    "transport",
    "port",
    "workers",
    "budget",
    "files",
    "commit",
    "threshold",
    "config-name",
    "repo",
    "output",
    "exclude",
    "cost",
    "include-skeleton",
    "include-summary",
    "include-snippet",
    "dry-run",
    "quality",
    "list",
    "reset",
    "validate",
    "alpha",
    "beta",
    "gamma",
    "decay",
    "parent-boost-multiplier",
    "changed-since",
    "force",
    "scan",
    "store",
    "yes",
    "single",
    "skip-doctor",
    "name",
    "repos",
    "expires",
    "id",
    "path",
    "dataset",
    "baseline",
    "agents-md",
    "strategy",
    "install",
    "local",
    "quiet",
    "batch-size",
    "top",
  ];
  warnUnknownFlags(parsed, GLOBAL_FLAGS);

  try {
    switch (parsed.command) {
      case "init":
        await cmdInit(repoRoot);
        break;

      case "setup": {
        const { cmdSetup } = await import("./setup");
        await cmdSetup(repoRoot, {
          scanDir: flag(parsed, "scan"),
          single: hasFlag(parsed, "single"),
          yes: hasFlag(parsed, "yes"),
          store: flag(parsed, "store") as "pg" | "sqlite" | undefined,
          skipDoctor: hasFlag(parsed, "skip-doctor"),
          dryRun: hasFlag(parsed, "dry-run"),
        });
        break;
      }

      case "reindex": {
        const budgetStr = flag(parsed, "budget");
        const scope = flag(parsed, "scope");
        const repoName = flag(parsed, "repo");

        if (repoName) {
          const repo = await repoGetByName(repoRoot, repoName);
          if (!repo) {
            console.error(
              `Repo "${repoName}" not found. Use \`codeindex repo list\` to see registered repos.`,
            );
            process.exit(1);
          }
          await cmdReindex(
            repo.root_path,
            hasFlag(parsed, "dry-run"),
            budgetStr ? parseFloat(budgetStr) : undefined,
            hasFlag(parsed, "force"),
          );
        } else if (scope === "all") {
          const allRepos = await repoGetAll(repoRoot);
          if (allRepos.length === 0) {
            console.error("No repos registered. Use `codeindex repo add <path>` first.");
            process.exit(1);
          }
          const workersStr = flag(parsed, "workers");
          const workers = workersStr ? parseInt(workersStr) : 3;
          const budget = budgetStr ? parseFloat(budgetStr) : 0;

          const results = await parallelReindex(
            allRepos.map((r) => ({ root: r.root_path, name: r.name })),
            workers,
            budget,
          );

          // Print summary
          console.log("\nReindex Summary:");
          for (const r of results) {
            const icon = r.status === "ok" ? "OK" : "FAIL";
            console.log(`  [${icon}] ${r.repo}${r.error ? `: ${r.error}` : ""}`);
          }
          const ok = results.filter((r) => r.status === "ok").length;
          const fail = results.filter((r) => r.status === "error").length;
          console.log(`\n${ok} succeeded, ${fail} failed`);

          if (fail > 0) process.exit(1);
        } else {
          await cmdReindex(
            repoRoot,
            hasFlag(parsed, "dry-run"),
            budgetStr ? parseFloat(budgetStr) : undefined,
            hasFlag(parsed, "force"),
          );
        }
        break;
      }

      case "update": {
        const filesRaw = flag(parsed, "files");
        const files = filesRaw ? filesRaw.split(",") : parsed.positional;
        await cmdUpdate(repoRoot, files, flag(parsed, "commit"));
        break;
      }

      case "search": {
        const query = parsed.positional[0];
        if (!query) {
          console.error("Usage: codeindex search <query> [options]");
          process.exit(1);
        }
        const minScoreStr = flag(parsed, "min-score");
        const topNStr = flag(parsed, "top-n");
        const langRaw = flag(parsed, "lang");
        const dirRaw = flag(parsed, "dir");
        await cmdSearch(repoRoot, query, {
          minScore: minScoreStr ? parseFloat(minScoreStr) : undefined,
          topN: topNStr ? parseInt(topNStr) : undefined,
          scope: flag(parsed, "scope"),
          includeSkeleton: hasFlag(parsed, "include-skeleton"),
          includeSummary: hasFlag(parsed, "include-summary"),
          includeSnippet: hasFlag(parsed, "include-snippet"),
          format: flag(parsed, "format"),
          json: hasFlag(parsed, "json"),
          pretty: hasFlag(parsed, "pretty"),
          lang: langRaw ? langRaw.split(",") : undefined,
          dir: dirRaw ? dirRaw.split(",") : undefined,
          since: flag(parsed, "since"),
          explain: hasFlag(parsed, "explain"),
          changedSince: flag(parsed, "changed-since"),
        });
        break;
      }

      case "export": {
        const excludeRaw = flag(parsed, "exclude");
        await cmdExport(repoRoot, flag(parsed, "out") ?? ".codeindex.db", {
          redactEmbeddings: !hasFlag(parsed, "include-embeddings"),
          redactCommits: hasFlag(parsed, "redact-commits"),
          excludePatterns: excludeRaw ? excludeRaw.split(",") : undefined,
        });
        break;
      }

      case "install-hook":
        await installHook(repoRoot);
        console.log("Post-commit hook installed.");
        break;

      case "config":
        if (hasFlag(parsed, "list")) {
          await cmdConfigList(repoRoot);
        } else {
          await cmdConfig(repoRoot, process.argv.slice(3));
        }
        break;

      case "manifest":
        await cmdManifest(repoRoot);
        break;

      case "check": {
        const report = await runHealthCheck(repoRoot);
        if (hasFlag(parsed, "json")) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          console.log(`Health check: ${report.repo}`);
          console.log("\u2500".repeat(50));
          for (const r of report.results) {
            const icon = r.result.passed ? "\u2713" : r.severity === "error" ? "\u2717" : "\u26A0";
            console.log(`  ${icon} [${r.severity}] ${r.policy}: ${r.result.message}`);
          }
          console.log("\u2500".repeat(50));
          console.log(report.passed ? "All checks passed." : "Some checks failed.");
        }
        let exitCode = report.passed ? 0 : 1;

        if (hasFlag(parsed, "quality")) {
          const datasetPath = flag(parsed, "dataset");
          const baselinePath = flag(parsed, "baseline");
          const qualityReport = await runQualityCheck(repoRoot, datasetPath, baselinePath);
          if (hasFlag(parsed, "json")) {
            console.log(JSON.stringify(qualityReport, null, 2));
          } else {
            console.log("\nQuality check:");
            console.log("\u2500".repeat(50));
            for (const r of qualityReport.results) {
              const icon = r.result.passed ? "\u2713" : "\u2717";
              console.log(`  ${icon} ${r.policy}: ${r.result.message}`);
            }
            console.log("\u2500".repeat(50));
            console.log(
              qualityReport.passed ? "All quality checks passed." : "Quality checks failed.",
            );
          }
          if (!qualityReport.passed) exitCode = 1;
        }
        if (exitCode !== 0) process.exit(exitCode);
        break;
      }

      case "cross-repo": {
        console.log("Discovering cross-repo relationships...");
        const edges = await discoverCrossRepoEdges(repoRoot);
        if (edges.length === 0) {
          console.log("No cross-repo relationships found.");
        } else {
          console.log(`Found ${edges.length} cross-repo edge(s).`);
          if (hasFlag(parsed, "json")) {
            console.log(JSON.stringify(edges, null, 2));
          } else {
            for (const e of edges) {
              console.log(
                `  repo:${e.sourceRepoId} → repo:${e.targetRepoId}  ${e.importedModule} [${e.language}]`,
              );
            }
          }
        }
        break;
      }

      case "token": {
        const sub = parsed.positional[0];
        switch (sub) {
          case "create": {
            const name = flag(parsed, "name");
            const repos = flag(parsed, "repos");
            if (!name || !repos) {
              console.error("Usage: codeindex token create --name <name> --repos <id1,id2,...>");
              process.exit(1);
            }
            const rawIds = repos.split(",").map((s) => s.trim());
            const invalidIds = rawIds.filter((s) => isNaN(parseInt(s, 10)));
            if (invalidIds.length > 0) {
              console.error(
                `Error: invalid repo IDs: ${invalidIds.join(", ")} — all IDs must be numeric`,
              );
              process.exit(1);
            }
            const repoIds = rawIds.map((s) => parseInt(s, 10));
            if (repoIds.length === 0) {
              console.error("Error: --repos must be a comma-separated list of numeric IDs");
              process.exit(1);
            }
            const expiresAt = flag(parsed, "expires");
            if (expiresAt && isNaN(new Date(expiresAt).getTime())) {
              console.error(`Error: --expires "${expiresAt}" is not a valid ISO date string`);
              process.exit(1);
            }
            const plaintext = await createToken(repoRoot, name, repoIds, expiresAt);
            console.log(`Token created: ${plaintext}`);
            console.log("Store this token securely — it cannot be retrieved again.");
            break;
          }
          case "list": {
            const tokens = await listTokens(repoRoot);
            if (tokens.length === 0) {
              console.log("No tokens found.");
            } else {
              console.log(
                `${"ID".padEnd(5)}${"Name".padEnd(20)}${"Repos".padEnd(15)}${"Revoked".padEnd(10)}Expires`,
              );
              for (const t of tokens) {
                console.log(
                  `${String(t.id).padEnd(5)}${t.name.padEnd(20)}${t.repoIds.join(",").padEnd(15)}${String(t.revoked).padEnd(10)}${t.expiresAt ?? "-"}`,
                );
              }
            }
            break;
          }
          case "revoke": {
            const id = flag(parsed, "id");
            if (!id) {
              console.error("Usage: codeindex token revoke --id <token_id>");
              process.exit(1);
            }
            const parsedId = parseInt(id, 10);
            if (isNaN(parsedId)) {
              console.error("Error: --id must be a numeric token ID");
              process.exit(1);
            }
            await revokeToken(repoRoot, parsedId);
            console.log(`Token ${id} revoked.`);
            break;
          }
          default:
            console.error("Usage: codeindex token <create|list|revoke>");
            process.exit(1);
        }
        break;
      }

      case "status":
        await cmdStatus(repoRoot, hasFlag(parsed, "cost"), hasFlag(parsed, "quality"));
        break;

      case "telemetry":
        await cmdTelemetry(parsed);
        break;

      case "auth": {
        const { cmdAuth } = await import("./commands/auth");
        await cmdAuth();
        break;
      }

      case "doctor":
        await cmdDoctor(repoRoot);
        break;

      case "intent":
        await generateIntent(repoRoot, flag(parsed, "out"));
        break;

      case "drift": {
        const agentsMdPath = flag(parsed, "agents-md") ?? "AGENTS.md";
        const thresholdStr = flag(parsed, "threshold");
        await detectDrift(
          repoRoot,
          agentsMdPath,
          thresholdStr ? parseFloat(thresholdStr) : undefined,
          flag(parsed, "out"),
        );
        break;
      }

      case "repo": {
        const subCmd = parsed.positional[0];
        switch (subCmd) {
          case "add":
            await repoAdd(repoRoot, parsed.positional[1] ?? repoRoot);
            break;
          case "remove":
            if (!parsed.positional[1]) {
              console.error("Usage: codeindex repo remove <name>");
              process.exit(1);
            }
            await repoRemove(repoRoot, parsed.positional[1]);
            break;
          case "list":
            await repoList(repoRoot);
            break;
          case "status":
            await repoStatus(repoRoot, parsed.positional[1]);
            break;
          case "purge":
            if (!parsed.positional[1]) {
              console.error("Usage: codeindex repo purge <name> [--force]");
              process.exit(1);
            }
            await repoPurge(repoRoot, parsed.positional[1], hasFlag(parsed, "force"));
            break;
          default:
            console.error("Usage: codeindex repo <add|remove|list|status|purge>");
            process.exit(1);
        }
        break;
      }

      case "graph": {
        const graphFormat = flag(parsed, "format") ?? "mermaid";
        await cmdGraph(repoRoot, graphFormat);
        break;
      }

      case "xref": {
        const symbolName = parsed.positional[0];
        if (!symbolName) {
          console.error("Usage: codeindex xref <symbol> [--format json|table]");
          process.exit(1);
        }
        const xrefFormat = flag(parsed, "format") ?? "table";
        const xrefResult = await xrefSymbol(repoRoot, symbolName);
        if (xrefFormat === "json") {
          console.log(formatXrefJson(xrefResult));
        } else {
          console.log(formatXrefTable(xrefResult));
        }
        break;
      }

      case "mcp-config":
        await cmdMcpConfig(parsed);
        break;

      case "serve": {
        const { createMcpServer } = await import("./mcp/server");
        const { startStdio, startSSE } = await import("./mcp/transport");
        const transport = flag(parsed, "transport") ?? "stdio";
        if (transport === "sse") {
          const portStr = flag(parsed, "port");
          await startSSE(
            (session) => createMcpServer(repoRoot, session),
            portStr ? parseInt(portStr) : 3100,
            repoRoot,
          );
        } else {
          const { authenticateSession } = await import("./mcp/auth");
          const token = process.env.CODEINDEX_TOKEN;
          const session = await authenticateSession(repoRoot, token);
          if (session === null) {
            console.error("Authentication failed: invalid or missing token.");
            process.exit(1);
          }
          const mcpServer = createMcpServer(repoRoot, session);
          await startStdio(mcpServer);
        }
        break;
      }

      case "cloud": {
        const { cmdCloud } = await import("./commands/cloud");
        await cmdCloud(repoRoot, parsed);
        break;
      }

      case "resolve": {
        const { cmdResolve } = await import("./resolve/resolver");
        await cmdResolve(parsed);
        break;
      }

      case "cache": {
        const { cmdCache } = await import("./resolve/git-cache");
        await cmdCache(parsed);
        break;
      }

      case "prune": {
        await cmdPrune(repoRoot, {
          json: hasFlag(parsed, "json"),
          dryRun: hasFlag(parsed, "dry-run"),
        });
        break;
      }

      case "dedup": {
        const sub = parsed.positional[0];
        switch (sub) {
          case "stats":
            await cmdDedupStats(repoRoot, { json: hasFlag(parsed, "json") });
            break;
          case "gc":
            await cmdDedupGc(repoRoot, {
              json: hasFlag(parsed, "json"),
              dryRun: hasFlag(parsed, "dry-run"),
            });
            break;
          default:
            console.error("Usage: codeindex dedup <stats|gc>");
            process.exit(1);
        }
        break;
      }

      case "":
      case "help":
      case "--help":
      case "-h":
        console.log(HELP_TEXT);
        break;

      default:
        console.error(
          `Unknown command: '${parsed.command}'. Run 'codeindex' for usage, or 'codeindex --llm' for the agent-oriented usage doc.`,
        );
        process.exit(1);
    }
  } finally {
    await closePg();
    await closeSqlite();
  }
}

main().catch((err) => {
  console.error(formatError(err));
  process.exit(1);
});
