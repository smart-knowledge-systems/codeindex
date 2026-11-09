# Tree-sitter grammars

## How grammars ship

Grammars are built from source by `scripts/build-grammars.ts` and committed as `grammars/wasm/tree-sitter-<lang>.wasm`. The grammar package versions and the `tree-sitter-cli` version that compiles them are pinned in `grammars/package.json`, which has its own lockfile and `node_modules`, so the root install never pulls grammar sources or the CLI.

`src/index/skeleton/wasm-assets.ts` imports the runtime wasm and every grammar with `{ type: "file" }`. Under bun that is a path on disk; inside a `bun build --compile` binary it is an embedded `/$bunfs` path. Loading from `node_modules` or the repo tree does not work in a compiled binary, because neither exists there.

## Why grammars are not taken from npm

- `tree-sitter-wasms` (the old source, last released at 0.1.13) was built with tree-sitter-cli 0.20.8. Its grammars use the legacy `dylink` wasm section, and web-tree-sitter 0.26 and later load only `dylink.0`, so `Language.load` fails in `getDylinkMetadata` (tree-sitter/tree-sitter#5171). Other prebuilt bundles are either built with an old CLI or miss languages we support.
- The latest official grammar packages load fine, but they change node shapes. Switching all at once silently degraded C# (return types dropped), Go (`var (...)` groups lost), Kotlin (imports, parameter names and properties dropped), Lua (a different grammar; almost no entries) and Scala (imports garbled).

So the vendored grammars are the same versions `tree-sitter-wasms@0.1.13` shipped, rebuilt with a current CLI.

## Changing a grammar

1. Change its version in `grammars/package.json`, then run `bun install` in `grammars/`.
2. Run `bun scripts/build-grammars.ts <lang>`. The CLI downloads wasi-sdk and binaryen into `~/.cache/tree-sitter` on first use; no emscripten or docker is needed. A package that ships `grammar.js` without `src/parser.c` (swift) is generated first.
3. Run `bun test`. `test/skeleton-golden.test.ts` snapshots every fixture's skeleton; read the snapshot diff, fix the `lang-*.ts` extractor for any node-shape change, and update the snapshot with `bun test --update-snapshots` only once the new output is right.

Move one language per change, so each snapshot diff is reviewable on its own.

## Adding a language

Add it to `SupportedLanguage`, then to `SOURCES` in `scripts/build-grammars.ts` and `GRAMMAR_WASM` in `wasm-assets.ts`; both are keyed by `SupportedLanguage`, so a missing entry is a type error. Add its grammar package to `grammars/package.json`, build it, and add a fixture.

## Upgrading the runtime

`web-tree-sitter` is pinned exactly. Keep `tree-sitter-cli` in `grammars/package.json` at the runtime's version, so the grammars carry an ABI and wasm format the runtime reads; when bumping one, bump the other and rebuild every grammar. The golden snapshots must stay unchanged, since a runtime bump alone should not change parse trees.
