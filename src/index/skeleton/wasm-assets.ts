import type { SupportedLanguage } from "./types";

// `with { type: "file" }` resolves to a real path under bun and to an embedded
// /$bunfs path inside a `bun build --compile` binary, where node_modules and
// the repo tree do not exist.
import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import typescriptWasm from "../../../grammars/wasm/tree-sitter-typescript.wasm" with { type: "file" };
import tsxWasm from "../../../grammars/wasm/tree-sitter-tsx.wasm" with { type: "file" };
import javascriptWasm from "../../../grammars/wasm/tree-sitter-javascript.wasm" with { type: "file" };
import pythonWasm from "../../../grammars/wasm/tree-sitter-python.wasm" with { type: "file" };
import rustWasm from "../../../grammars/wasm/tree-sitter-rust.wasm" with { type: "file" };
import goWasm from "../../../grammars/wasm/tree-sitter-go.wasm" with { type: "file" };
import javaWasm from "../../../grammars/wasm/tree-sitter-java.wasm" with { type: "file" };
import cWasm from "../../../grammars/wasm/tree-sitter-c.wasm" with { type: "file" };
import cppWasm from "../../../grammars/wasm/tree-sitter-cpp.wasm" with { type: "file" };
import cSharpWasm from "../../../grammars/wasm/tree-sitter-c_sharp.wasm" with { type: "file" };
import kotlinWasm from "../../../grammars/wasm/tree-sitter-kotlin.wasm" with { type: "file" };
import swiftWasm from "../../../grammars/wasm/tree-sitter-swift.wasm" with { type: "file" };
import rubyWasm from "../../../grammars/wasm/tree-sitter-ruby.wasm" with { type: "file" };
import phpWasm from "../../../grammars/wasm/tree-sitter-php.wasm" with { type: "file" };
import luaWasm from "../../../grammars/wasm/tree-sitter-lua.wasm" with { type: "file" };
import scalaWasm from "../../../grammars/wasm/tree-sitter-scala.wasm" with { type: "file" };
import zigWasm from "../../../grammars/wasm/tree-sitter-zig.wasm" with { type: "file" };
import elixirWasm from "../../../grammars/wasm/tree-sitter-elixir.wasm" with { type: "file" };

export const RUNTIME_WASM: string = runtimeWasm;

export const GRAMMAR_WASM: Record<SupportedLanguage, string> = {
  typescript: typescriptWasm,
  tsx: tsxWasm,
  javascript: javascriptWasm,
  python: pythonWasm,
  rust: rustWasm,
  go: goWasm,
  java: javaWasm,
  c: cWasm,
  cpp: cppWasm,
  c_sharp: cSharpWasm,
  kotlin: kotlinWasm,
  swift: swiftWasm,
  ruby: rubyWasm,
  php: phpWasm,
  lua: luaWasm,
  scala: scalaWasm,
  zig: zigWasm,
  elixir: elixirWasm,
};
