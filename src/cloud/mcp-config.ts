// Cloud MCP config command

import path from "path";
import os from "os";
import { hasFlag, flag, type ParsedArgs } from "../cli";
import { CloudClient } from "./client";
import { formatError } from "../errors";

interface McpServerStdioConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface McpServerHttpConfig {
  url: string;
  headers: Record<string, string>;
}

type McpServerConfig = McpServerStdioConfig | McpServerHttpConfig;

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/** Known editor config paths (relative to home). */
const EDITOR_CONFIGS: Record<string, string[]> = {
  "claude-code": [".claude.json", ".config/claude/settings.json"],
  cursor: [".cursor/mcp.json"],
  windsurf: [".windsurf/mcp.json", ".codeium/windsurf/mcp_config.json"],
};

function buildCloudMcpConfig(baseUrl: string, token: string): McpConfig {
  return {
    mcpServers: {
      "codeindex-cloud": {
        url: `${baseUrl}/mcp`,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  };
}

function buildLocalMcpConfig(baseUrl: string, token: string): McpConfig {
  return {
    mcpServers: {
      codeindex: {
        command: "cidx",
        args: ["mcp", "--transport", "stdio"],
        env: {
          CIDX_CLOUD_URL: baseUrl,
          CIDX_CLOUD_TOKEN: token,
        },
      },
    },
  };
}

async function installToEditor(config: McpConfig, editor: string): Promise<boolean> {
  const home = os.homedir();
  const paths = EDITOR_CONFIGS[editor];
  if (!paths) {
    process.stderr.write(`Unknown editor: ${editor}\n`);
    process.stderr.write(`Supported editors: ${Object.keys(EDITOR_CONFIGS).join(", ")}\n`);
    return false;
  }

  for (const relPath of paths) {
    const absPath = path.join(home, relPath);
    const file = Bun.file(absPath);
    if (await file.exists()) {
      // Merge into existing config
      let existing: Record<string, unknown> = {};
      try {
        existing = (await file.json()) as Record<string, unknown>;
      } catch {
        // Corrupted — overwrite
      }
      const merged = {
        ...existing,
        mcpServers: {
          ...((existing.mcpServers as Record<string, unknown>) ?? {}),
          ...config.mcpServers,
        },
      };
      await Bun.write(absPath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
      process.stderr.write(`Updated ${absPath}\n`);
      return true;
    }
  }

  // No existing file — write to first path
  const absPath = path.join(home, paths[0]);
  const dir = path.dirname(absPath);
  const { mkdirSync } = await import("fs");
  mkdirSync(dir, { recursive: true });
  await Bun.write(absPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  process.stderr.write(`Created ${absPath}\n`);
  return true;
}

export async function cloudMcpConfig(parsed: ParsedArgs): Promise<void> {
  const client = new CloudClient();
  await client.loadCredentials();

  if (!client.isAuthenticated()) {
    process.stderr.write("Not logged in. Run `cidx cloud login` to authenticate.\n");
    process.exit(1);
  }

  const isLocal = hasFlag(parsed, "local");
  const buildConfig = isLocal ? buildLocalMcpConfig : buildCloudMcpConfig;
  // stdio env vars are shell-evaluated by editors; HTTP headers are sent verbatim
  const placeholder = isLocal ? "$(cidx cloud token)" : "<YOUR_TOKEN>";
  const config = buildConfig(client.baseUrl, placeholder);

  // Read the actual token for install mode
  if (hasFlag(parsed, "install")) {
    const credPath = CloudClient.getCredentialsPath();
    const credFile = Bun.file(credPath);
    let token = "";
    try {
      const creds = (await credFile.json()) as { token: string };
      token = creds.token;
    } catch {
      process.stderr.write("Could not read credentials. Run `cidx cloud login` first.\n");
      process.exit(1);
    }

    const installConfig = buildConfig(client.baseUrl, token);
    const editor = flag(parsed, "config-name") ?? "claude-code";

    try {
      const ok = await installToEditor(installConfig, editor);
      if (!ok) process.exit(1);
    } catch (err) {
      process.stderr.write(`Install failed: ${formatError(err)}\n`);
      process.exit(1);
    }
    return;
  }

  // Default: print config to stdout
  process.stdout.write(JSON.stringify(config, null, 2) + "\n");
}
