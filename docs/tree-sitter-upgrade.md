# web-tree-sitter Upgrade Guide

## Current State

- `web-tree-sitter@0.25.3` with a type-fix patch (`patches/web-tree-sitter@0.25.3.patch`)
- `tree-sitter-wasms@0.1.13` provides prebuilt `.wasm` grammar files for all 9 languages
- WASM files loaded from `node_modules/tree-sitter-wasms/out/tree-sitter-{lang}.wasm`

### Why the patch exists

Version 0.25.3's TypeScript declarations incorrectly type several `Node` array properties as `(Node | null)[]` instead of `Node[]`. The patch fixes:
- `children`, `namedChildren`
- `childrenForFieldName`, `childrenForFieldId`
- `descendantsOfType`

Version 0.26.6 includes these fixes upstream, making the patch unnecessary.

## Why we can't upgrade to 0.26.6

The `.wasm` grammar files from `tree-sitter-wasms@0.1.13` are **binary-incompatible** with `web-tree-sitter@0.26.x`. The WASM dylink metadata format changed between the 0.25.x and 0.26.x runtimes, causing `Language.load()` to fail at `getDylinkMetadata`.

### Tested combinations

| web-tree-sitter | WASM source | Result |
|---|---|---|
| 0.25.3 | `tree-sitter-wasms@0.1.13` | Works |
| 0.26.6 | `tree-sitter-wasms@0.1.13` | **Fails** — ABI mismatch |
| 0.26.6 | Grammar-package WASMs (e.g., `tree-sitter-typescript@0.23.2`) | Works |

### Why grammar-package WASMs aren't a drop-in solution

Only 2 of 9 supported languages ship `.wasm` files in their npm packages:

| Language | Package | Ships `.wasm`? |
|---|---|---|
| TypeScript/TSX | `tree-sitter-typescript@0.23.2` | Yes |
| JavaScript | `tree-sitter-javascript@0.25.0` | Yes |
| Python | `tree-sitter-python@0.25.0` | No |
| Rust | `tree-sitter-rust@0.24.0` | No |
| Go | `tree-sitter-go@0.25.0` | No |
| Java | `tree-sitter-java@0.23.5` | No |
| C | `tree-sitter-c@0.24.1` | No |
| C++ | `tree-sitter-cpp@0.23.4` | No |
| C# | `tree-sitter-c-sharp@0.23.1` | No |

## Upgrade triggers

The upgrade becomes trivial when either of these happens:

1. **`tree-sitter-wasms` publishes a 0.26.x-compatible release** — bump both versions, delete the patch, done.
2. **All 9 grammar packages ship `.wasm` files** — replace `tree-sitter-wasms` with individual grammar deps, update `WASM_DIR`.

## Manual upgrade procedure

If neither trigger has fired and you need to upgrade proactively:

```bash
# 1. Install the tree-sitter CLI
brew install tree-sitter

# 2. Add grammar packages as dev dependencies
bun add -d tree-sitter-typescript tree-sitter-javascript tree-sitter-python \
  tree-sitter-rust tree-sitter-go tree-sitter-java tree-sitter-c tree-sitter-cpp \
  tree-sitter-c-sharp

# 3. Build WASMs for each grammar
mkdir -p grammars
for lang in typescript tsx javascript python rust go java c cpp c_sharp; do
  tree-sitter build --wasm node_modules/tree-sitter-$lang -o grammars/tree-sitter-$lang.wasm
done

# 4. Update the WASM loading path
# In src/index/skeleton.ts line 66, change:
#   const WASM_DIR = path.join(import.meta.dir, "../../node_modules/tree-sitter-wasms/out");
# To:
#   const WASM_DIR = path.join(import.meta.dir, "../../grammars");

# 5. Update dependencies
bun add web-tree-sitter@0.26.6
bun remove tree-sitter-wasms
rm patches/web-tree-sitter@0.25.3.patch

# 6. Verify
bun test  # skeleton test suite must pass for all 9 languages
bun run check  # typecheck should pass without the patch
```

Note: `tree-sitter build --wasm` requires either Emscripten SDK or Docker. The tree-sitter CLI may bundle its own WASM compiler in recent versions — check `tree-sitter build --help` for details.
