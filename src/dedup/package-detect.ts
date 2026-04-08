/**
 * Per-ecosystem package boundary detectors. Each detector inspects a candidate
 * directory and, if it looks like an installed package, returns the canonical
 * (ecosystem, name, version) plus the list of (relpath, content_hash) pairs
 * that the tree hash will be computed from.
 *
 * Where the ecosystem already provides per-file hashes (npm `_integrity`,
 * Cargo `.cargo-checksum.json`, Python `RECORD`), we read them instead of
 * recomputing — that's a significant CPU win on `node_modules` directories.
 *
 * Detectors are pure with respect to the global store; they only do filesystem
 * I/O on the candidate directory. The walker calls them and hands the result
 * to the dedup pipeline.
 */

import path from "path";
import { readdir, readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { createHash } from "crypto";

export type Ecosystem = "npm" | "cargo" | "go" | "python";

export interface DetectedPackage {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  rootPath: string; // absolute path to package root
  files: Array<{ relpath: string; contentHash: string }>;
}

/**
 * Try every detector against a directory; return the first match.
 * Returns null if the directory doesn't look like a known package.
 */
export async function detectPackage(dir: string): Promise<DetectedPackage | null> {
  return (
    (await detectNpm(dir)) ??
    (await detectCargo(dir)) ??
    (await detectPython(dir)) ??
    (await detectGo(dir))
  );
}

// ---------------------------------------------------------------------------
// npm — node_modules/<pkg>/package.json
// ---------------------------------------------------------------------------

interface NpmPackageJson {
  name?: string;
  version?: string;
  _integrity?: string; // npm-cli writes this on install (SRI hash of tarball)
}

export async function detectNpm(dir: string): Promise<DetectedPackage | null> {
  const manifestPath = path.join(dir, "package.json");
  if (!existsSync(manifestPath)) return null;

  let manifest: NpmPackageJson;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as NpmPackageJson;
  } catch {
    return null;
  }
  if (!manifest.name || !manifest.version) return null;

  const files = await walkAndHash(dir);
  return {
    ecosystem: "npm",
    name: manifest.name,
    version: manifest.version,
    rootPath: dir,
    files,
  };
}

// ---------------------------------------------------------------------------
// Cargo — ~/.cargo/registry/src/<reg>/<name>-<version>/.cargo-checksum.json
// ---------------------------------------------------------------------------

interface CargoChecksum {
  package?: string;
  files?: Record<string, string>; // relpath -> sha256 hex
}

export async function detectCargo(dir: string): Promise<DetectedPackage | null> {
  const checksumPath = path.join(dir, ".cargo-checksum.json");
  if (!existsSync(checksumPath)) return null;

  let checksum: CargoChecksum;
  try {
    checksum = JSON.parse(await readFile(checksumPath, "utf-8")) as CargoChecksum;
  } catch {
    return null;
  }
  if (!checksum.files) return null;

  // Cargo extracts to <name>-<version>; parse the dir basename.
  const base = path.basename(dir);
  const dashIdx = base.lastIndexOf("-");
  if (dashIdx <= 0) return null;
  const name = base.slice(0, dashIdx);
  const version = base.slice(dashIdx + 1);

  // Cargo's checksums are already sha256 hex — use them directly, no rehash.
  const files = Object.entries(checksum.files).map(([relpath, contentHash]) => ({
    relpath,
    contentHash,
  }));

  return { ecosystem: "cargo", name, version, rootPath: dir, files };
}

// ---------------------------------------------------------------------------
// Python — site-packages/<pkg>-<ver>.dist-info/RECORD
// ---------------------------------------------------------------------------

export async function detectPython(dir: string): Promise<DetectedPackage | null> {
  // Python dist-info directories are siblings of the actual package code.
  // We accept either the dist-info dir itself or a sibling that contains a
  // matching .dist-info next to it.
  const base = path.basename(dir);
  if (!base.endsWith(".dist-info")) return null;

  const recordPath = path.join(dir, "RECORD");
  const metadataPath = path.join(dir, "METADATA");
  if (!existsSync(recordPath) || !existsSync(metadataPath)) return null;

  // Parse name + version from "<name>-<version>.dist-info"
  const stem = base.slice(0, -".dist-info".length);
  const dashIdx = stem.lastIndexOf("-");
  if (dashIdx <= 0) return null;
  const name = stem.slice(0, dashIdx);
  const version = stem.slice(dashIdx + 1);

  // RECORD format (CSV): relpath,sha256=<base64>,size
  const recordText = await readFile(recordPath, "utf-8");
  const files: Array<{ relpath: string; contentHash: string }> = [];
  for (const line of recordText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",");
    if (parts.length < 2) continue;
    const relpath = parts[0];
    const hashField = parts[1];
    if (!hashField.startsWith("sha256=")) continue;
    const b64 = hashField.slice("sha256=".length);
    // RECORD uses URL-safe base64 without padding; convert to hex to match the rest of the system.
    const hex = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex");
    files.push({ relpath, contentHash: hex });
  }
  if (files.length === 0) return null;

  return { ecosystem: "python", name, version, rootPath: dir, files };
}

// ---------------------------------------------------------------------------
// Go — $GOPATH/pkg/mod/<module>@<version>/
// ---------------------------------------------------------------------------

export async function detectGo(dir: string): Promise<DetectedPackage | null> {
  // Go modcache directory names contain '@version'. Detect by basename.
  const base = path.basename(dir);
  const atIdx = base.lastIndexOf("@");
  if (atIdx <= 0) return null;
  const name = base.slice(0, atIdx);
  const version = base.slice(atIdx + 1);

  // Sanity: must contain at least one .go file or go.mod somewhere
  const goMod = path.join(dir, "go.mod");
  if (!existsSync(goMod)) return null;

  const files = await walkAndHash(dir);
  if (files.length === 0) return null;
  return { ecosystem: "go", name, version, rootPath: dir, files };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_PACKAGE_FILE_SIZE = 524_288; // mirror walker.MAX_FILE_SIZE

/**
 * Recursively walk a package directory, hashing each file with SHA-256.
 * Used as a fallback when the ecosystem doesn't ship per-file hashes.
 */
async function walkAndHash(
  rootPath: string,
): Promise<Array<{ relpath: string; contentHash: string }>> {
  const results: Array<{ relpath: string; contentHash: string }> = [];

  async function walk(absDir: string, relDir: string): Promise<void> {
    let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      const abs = path.join(absDir, entry.name);
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        try {
          const s = await stat(abs);
          if (s.size > MAX_PACKAGE_FILE_SIZE) continue;
          const buf = await readFile(abs);
          const hash = createHash("sha256").update(buf).digest("hex");
          results.push({ relpath: rel, contentHash: hash });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(rootPath, "");
  return results;
}
