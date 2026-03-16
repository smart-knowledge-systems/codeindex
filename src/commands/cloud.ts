import type { ParsedArgs } from "../cli";

export async function cmdCloud(repoRoot: string, parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positional[0];

  switch (sub) {
    case "login": {
      const { cloudLogin } = await import("../cloud/auth");
      await cloudLogin();
      break;
    }
    case "logout": {
      const { cloudLogout } = await import("../cloud/auth");
      await cloudLogout();
      break;
    }
    case "status": {
      const { cloudStatus } = await import("../cloud/status");
      await cloudStatus(parsed);
      break;
    }
    case "reindex": {
      const { cloudReindex } = await import("../cloud/reindex");
      await cloudReindex(repoRoot, parsed);
      break;
    }
    case "search": {
      const { cloudSearch } = await import("../cloud/search");
      await cloudSearch(parsed);
      break;
    }
    case "migrate": {
      const { cloudMigrate } = await import("../cloud/migrate");
      await cloudMigrate(repoRoot, parsed);
      break;
    }
    case "mcp-config": {
      const { cloudMcpConfig } = await import("../cloud/mcp-config");
      await cloudMcpConfig(parsed);
      break;
    }
    case "sharing": {
      const { cloudSharing } = await import("../resolve/sharing");
      await cloudSharing(parsed);
      break;
    }
    default:
      console.error(
        "Usage: cidx cloud <login|logout|status|reindex|search|migrate|mcp-config|sharing>",
      );
      process.exit(1);
  }
}
