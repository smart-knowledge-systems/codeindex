// Per-repo sharing controls
// Config stored in ~/.config/cidx/sharing.json

import path from "path";
import os from "os";
import { existsSync } from "fs";
import { mkdir, writeFile, readFile } from "fs/promises";
import { type ParsedArgs } from "../cli";
import { CloudClient } from "../cloud/client";
import { logEvent } from "../logging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SharingEntry {
  enabled: boolean;
  updatedAt: string;
}

interface SharingConfig {
  repos: Record<string, SharingEntry>;
}

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), ".config", "cidx");
const CONFIG_PATH = path.join(CONFIG_DIR, "sharing.json");

async function loadSharingConfig(): Promise<SharingConfig> {
  try {
    if (!existsSync(CONFIG_PATH)) return { repos: {} };
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as SharingConfig;
  } catch {
    return { repos: {} };
  }
}

async function saveSharingConfig(config: SharingConfig): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true });
  }
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function isSharingEnabled(originUrl: string): Promise<boolean> {
  const config = await loadSharingConfig();
  return config.repos[originUrl]?.enabled === true;
}

export async function setSharingEnabled(originUrl: string, enabled: boolean): Promise<void> {
  const config = await loadSharingConfig();
  config.repos[originUrl] = {
    enabled,
    updatedAt: new Date().toISOString(),
  };
  await saveSharingConfig(config);

  // Best-effort sync to cloud
  try {
    const cloud = new CloudClient();
    await cloud.loadCredentials();
    if (cloud.isAuthenticated()) {
      await cloud.request("POST", "/sharing", {
        origin_url: originUrl,
        enabled,
      });
    }
  } catch (err) {
    logEvent({
      event: "infra.sharing.sync_failed",
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    // Don't fail — cloud sync is best-effort
  }
}

export async function listSharing(): Promise<Record<string, SharingEntry>> {
  const config = await loadSharingConfig();
  return config.repos;
}

// ---------------------------------------------------------------------------
// CLI: cidx cloud sharing <enable|disable|list> [repo]
// ---------------------------------------------------------------------------

export async function cloudSharing(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.positional[1];
  const repo = parsed.positional[2];

  if (sub === "enable") {
    if (!repo) {
      console.error("Usage: cidx cloud sharing enable <origin_url>");
      process.exit(1);
    }
    await setSharingEnabled(repo, true);
    console.log(`Sharing enabled for ${repo}`);
    return;
  }

  if (sub === "disable") {
    if (!repo) {
      console.error("Usage: cidx cloud sharing disable <origin_url>");
      process.exit(1);
    }
    await setSharingEnabled(repo, false);
    console.log(`Sharing disabled for ${repo}`);
    return;
  }

  if (sub === "list") {
    const repos = await listSharing();
    const entries = Object.entries(repos);
    if (entries.length === 0) {
      console.log("No sharing configuration. Sharing is disabled by default for all repos.");
      return;
    }
    console.log(`${"Repository".padEnd(50)}${"Sharing".padEnd(10)}Updated`);
    for (const [url, entry] of entries) {
      console.log(
        `${url.padEnd(50)}${(entry.enabled ? "enabled" : "disabled").padEnd(10)}${entry.updatedAt}`,
      );
    }
    return;
  }

  console.error("Usage: cidx cloud sharing <enable|disable|list> [origin_url]");
  process.exit(1);
}
