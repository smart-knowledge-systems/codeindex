# Lua Skeleton Extractor — Lessons Learned

Captured during M4 implementation session (2026-03-13). Lua was dropped from M4 scope but significant research was done.

## Tree-sitter AST Node Types

The tree-sitter-lua grammar uses different node type names than expected:

| Expected | Actual |
|----------|--------|
| `function_declaration` | `function_definition_statement` |
| `local_function` | `local_function_definition_statement` |
| `function_call` | Various — requires are often nested in `local_variable_declaration` |

## Function Declaration Patterns

```
function_definition_statement
  ├── variable (name: "M.new" or "M:getName" or "createGame")
  ├── parameter_list (parameters as `identifier` children)
  └── block (body)

local_function_definition_statement
  ├── identifier (name: "clamp")
  ├── parameter_list
  └── block
```

Key: `childForFieldName("name")` works correctly for both types. Parameters use `parameter_list` not `parameters`.

## Method vs Function Naming

Lua doesn't distinguish methods from functions at the AST level. Colon syntax (`M:getName`) is just syntactic sugar. The name field includes the full dotted/colon path:
- `M.new` — table function
- `M:getName` — method syntax (self is implicit)
- `createGame` — top-level function

## Import Detection

`require()` calls don't have their own AST node type. They appear as:
1. `local json = require("json")` → `local_variable_declaration` containing a `function_call`
2. `require("module")` → standalone expression

Best approach: use regex on node text to extract require paths, scanning `local_variable_declaration` and `variable_assignment` descendants.

## collectEntries Integration

Add these cases to `collectEntries`:
```typescript
case "function_definition_statement":
case "local_function_definition_statement": {
  const name = node.childForFieldName("name")?.text ?? "(anonymous)";
  entries.push({ name, kind: "function", startLine, endLine });
  return;
}
```

## WASM Availability

`tree-sitter-lua.wasm` is available in `tree-sitter-wasms@0.1.13`.

## Sample Fixture

A working fixture exists at `test/fixtures/sample.lua` covering module pattern, method functions, local functions, and top-level functions.
