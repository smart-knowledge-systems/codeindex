#!/usr/bin/env bun
/**
 * Compiles the grammar sources pinned in grammars/package.json to
 * grammars/wasm/tree-sitter-<lang>.wasm with the pinned tree-sitter-cli.
 *
 * The .wasm files are committed, so this only runs when a grammar or the
 * CLI version changes. The CLI downloads its own wasi-sdk into
 * ~/.cache/tree-sitter on first use; no emscripten or docker is needed.
 *
 * Usage: bun scripts/build-grammars.ts [lang...]
 */

import { existsSync, mkdirSync } from "fs";
import path from "path";
import type { SupportedLanguage } from "../src/index/skeleton/types";

const GRAMMARS = path.join(import.meta.dir, "..", "grammars");
const OUT = path.join(GRAMMARS, "wasm");
const CLI = path.join(GRAMMARS, "node_modules", ".bin", "tree-sitter");

const SOURCES: Record<SupportedLanguage, string> = {
  typescript: "tree-sitter-typescript/typescript",
  tsx: "tree-sitter-typescript/tsx",
  javascript: "tree-sitter-javascript",
  python: "tree-sitter-python",
  rust: "tree-sitter-rust",
  go: "tree-sitter-go",
  java: "tree-sitter-java",
  c: "tree-sitter-c",
  cpp: "tree-sitter-cpp",
  c_sharp: "tree-sitter-c-sharp",
  kotlin: "tree-sitter-kotlin",
  swift: "tree-sitter-swift",
  ruby: "tree-sitter-ruby",
  php: "tree-sitter-php/php",
  lua: "tree-sitter-lua",
  scala: "tree-sitter-scala",
  zig: "@tree-sitter-grammars/tree-sitter-zig",
  elixir: "tree-sitter-elixir",
};

async function run(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`failed in ${cwd}: ${cmd.join(" ")}`);
}

const requested = process.argv.slice(2) as SupportedLanguage[];
const unknown = requested.filter((lang) => !(lang in SOURCES));
if (unknown.length > 0) throw new Error(`unknown language: ${unknown.join(", ")}`);
const langs = requested.length > 0 ? requested : (Object.keys(SOURCES) as SupportedLanguage[]);

await run(["bun", "install", "--frozen-lockfile"], GRAMMARS);
mkdirSync(OUT, { recursive: true });

for (const lang of langs) {
  const src = path.join(GRAMMARS, "node_modules", SOURCES[lang]);
  // Some grammar packages (swift) publish grammar.js without the generated parser.
  if (!existsSync(path.join(src, "src", "parser.c"))) {
    console.log(`generate ${lang}`);
    await run([CLI, "generate"], src);
  }
  console.log(`build ${lang}`);
  await run([CLI, "build", "--wasm", "-o", path.join(OUT, `tree-sitter-${lang}.wasm`), src], src);
}
