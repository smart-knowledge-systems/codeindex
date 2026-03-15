#!/usr/bin/env bun
/**
 * Build script: compiles cidx/codeindex into standalone binaries for all
 * supported platforms using `bun build --compile`.
 *
 * Usage:
 *   bun run scripts/build.ts
 *
 * Outputs to dist/<platform>-<arch>/cidx (or cidx.exe on Windows).
 */

import { join } from "path";

const targets = [
  { platform: "darwin", arch: "arm64", target: "bun-darwin-arm64" },
  { platform: "darwin", arch: "x64", target: "bun-darwin-x64" },
  { platform: "linux", arch: "x64", target: "bun-linux-x64" },
  { platform: "linux", arch: "arm64", target: "bun-linux-arm64" },
] as const;

const entrypoint = join(import.meta.dir, "..", "src", "index.ts");

async function build() {
  const results: { platform: string; arch: string; ok: boolean; err?: string }[] = [];

  for (const { platform, arch, target } of targets) {
    const outDir = join(import.meta.dir, "..", "dist", `${platform}-${arch}`);
    const outFile = join(outDir, "cidx");

    console.log(`Building ${target} → ${outFile}`);

    const proc = Bun.spawn(
      ["bun", "build", "--compile", "--target", target, "--outfile", outFile, entrypoint],
      { stdout: "inherit", stderr: "inherit" }
    );

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      results.push({ platform, arch, ok: false, err: `exit code ${exitCode}` });
    } else {
      results.push({ platform, arch, ok: true });
    }
  }

  const failed = results.filter((r) => !r.ok);

  console.log("\nBuild summary:");
  for (const r of results) {
    const status = r.ok ? "✓" : `✗ (${r.err})`;
    console.log(`  ${r.platform}-${r.arch}: ${status}`);
  }

  if (failed.length > 0) {
    console.error(`\n${failed.length} build(s) failed.`);
    process.exit(1);
  }
}

build();
