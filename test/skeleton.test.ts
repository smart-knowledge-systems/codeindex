import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "fs/promises";
import path from "path";
import { initParser, extractSkeletonWithEntries } from "../src/index/skeleton";
import type { SkeletonEntry } from "../src/search/types";

const FIXTURES = path.join(import.meta.dir, "fixtures");

beforeAll(async () => {
  await initParser();
});

function hasEntry(entries: SkeletonEntry[], name: string, kind: string): SkeletonEntry | undefined {
  return entries.find((e) => e.name === name && e.kind === kind);
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

describe("TypeScript (.ts)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.ts");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[TypeScript]");
  });

  it("extracts loadConfig function", () => {
    const e = hasEntry(entries, "loadConfig", "function");
    expect(e).toBeDefined();
    expect(e!.startLine).toBeGreaterThan(0);
    expect(e!.endLine).toBeGreaterThanOrEqual(e!.startLine);
  });

  it("extracts Server class", () => {
    expect(hasEntry(entries, "Server", "class")).toBeDefined();
  });

  it("extracts class methods", () => {
    expect(hasEntry(entries, "start", "method")).toBeDefined();
  });

  it("extracts Config interface", () => {
    expect(hasEntry(entries, "Config", "interface")).toBeDefined();
  });

  it("skeleton text includes interface declaration", () => {
    expect(text).toContain("interface Config");
  });

  it("extracts UserId type alias", () => {
    expect(hasEntry(entries, "UserId", "type")).toBeDefined();
  });

  it("skeleton text includes type alias", () => {
    expect(text).toContain("type UserId = string | number");
  });

  it("extracts LogLevel enum", () => {
    expect(hasEntry(entries, "LogLevel", "enum")).toBeDefined();
  });

  it("skeleton text includes enum with members", () => {
    expect(text).toContain("enum LogLevel");
    expect(text).toContain("members:");
  });

  it("skeleton text includes imports", () => {
    expect(text).toContain("imports:");
  });
});

// ---------------------------------------------------------------------------
// TSX
// ---------------------------------------------------------------------------

describe("TSX (.tsx)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.tsx");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[TSX]");
  });

  it("extracts useCounter function", () => {
    expect(hasEntry(entries, "useCounter", "function")).toBeDefined();
  });

  it("extracts Button component", () => {
    expect(hasEntry(entries, "Button", "function")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

describe("JavaScript (.js)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.js");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[JavaScript]");
  });

  it("extracts formatDate function", () => {
    expect(hasEntry(entries, "formatDate", "function")).toBeDefined();
  });

  it("extracts Logger class", () => {
    expect(hasEntry(entries, "Logger", "class")).toBeDefined();
  });

  it("extracts log method", () => {
    expect(hasEntry(entries, "log", "method")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

describe("Python (.py)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.py");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[Python]");
  });

  it("extracts create_pool function", () => {
    expect(hasEntry(entries, "create_pool", "function")).toBeDefined();
  });

  it("extracts Database class", () => {
    expect(hasEntry(entries, "Database", "class")).toBeDefined();
  });

  it("extracts class methods", () => {
    expect(hasEntry(entries, "__init__", "method")).toBeDefined();
    expect(hasEntry(entries, "connect", "method")).toBeDefined();
    expect(hasEntry(entries, "query", "method")).toBeDefined();
  });

  it("skeleton text includes docstrings", () => {
    expect(text).toContain("Manages database connections");
  });

  it("extracts decorated class", () => {
    expect(hasEntry(entries, "Config", "class")).toBeDefined();
  });

  it("skeleton text includes class decorator", () => {
    expect(text).toContain("@dataclass");
    expect(text).toContain("class Config");
  });

  it("skeleton text includes method decorator", () => {
    expect(text).toContain("@property");
    expect(text).toContain("is_connected");
  });
});

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

describe("Rust (.rs)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.rs");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[Rust]");
  });

  it("extracts MemoryStore struct", () => {
    expect(hasEntry(entries, "MemoryStore", "struct")).toBeDefined();
  });

  it("extracts impl block", () => {
    expect(hasEntry(entries, "MemoryStore", "impl")).toBeDefined();
  });

  it("extracts impl methods as functions", () => {
    expect(hasEntry(entries, "get", "function")).toBeDefined();
    expect(hasEntry(entries, "set", "function")).toBeDefined();
  });

  it("extracts Storage trait", () => {
    expect(hasEntry(entries, "Storage", "trait")).toBeDefined();
  });

  it("extracts top-level function", () => {
    expect(hasEntry(entries, "create_store", "function")).toBeDefined();
  });

  it("skeleton text includes derive attribute", () => {
    expect(text).toContain("#[derive(Debug, Clone)]");
  });
});

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

describe("Go (.go)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.go");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[Go]");
  });

  it("extracts Router struct", () => {
    expect(hasEntry(entries, "Router", "struct")).toBeDefined();
  });

  it("extracts Handler interface", () => {
    expect(hasEntry(entries, "Handler", "interface")).toBeDefined();
  });

  it("extracts NewRouter function", () => {
    expect(hasEntry(entries, "NewRouter", "function")).toBeDefined();
  });

  it("extracts Handle method", () => {
    expect(hasEntry(entries, "Handle", "method")).toBeDefined();
  });

  it("extracts hello function", () => {
    expect(hasEntry(entries, "hello", "function")).toBeDefined();
  });

  it("skeleton text includes constant group", () => {
    expect(text).toContain("const (");
    expect(text).toContain("MaxRetries");
  });

  it("skeleton text includes var group", () => {
    expect(text).toContain("var (");
    expect(text).toContain("DefaultRouter");
  });
});

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

describe("Java (.java)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.java");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[Java]");
  });

  it("extracts UserService class", () => {
    expect(hasEntry(entries, "UserService", "class")).toBeDefined();
  });

  it("extracts class methods", () => {
    expect(hasEntry(entries, "addUser", "method")).toBeDefined();
    expect(hasEntry(entries, "getUsers", "method")).toBeDefined();
  });

  it("extracts Repository interface", () => {
    expect(hasEntry(entries, "Repository", "interface")).toBeDefined();
  });

  it("skeleton text includes method annotations", () => {
    expect(text).toContain("@Override");
    expect(text).toContain("@Deprecated");
  });
});

// ---------------------------------------------------------------------------
// C
// ---------------------------------------------------------------------------

describe("C (.c)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.c");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[C]");
  });

  it("extracts functions", () => {
    expect(hasEntry(entries, "point_new", "function")).toBeDefined();
    expect(hasEntry(entries, "rect_area", "function")).toBeDefined();
  });

  it("skeleton text includes imports", () => {
    expect(text).toContain("imports:");
  });

  it("extracts typedefs", () => {
    expect(hasEntry(entries, "Point", "typedef")).toBeDefined();
    expect(hasEntry(entries, "Rect", "typedef")).toBeDefined();
  });

  it("skeleton text includes typedef", () => {
    expect(text).toContain("typedef struct Point");
  });
});

// ---------------------------------------------------------------------------
// C++
// ---------------------------------------------------------------------------

describe("C++ (.cpp)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.cpp");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[C++]");
  });

  it("extracts shapes namespace", () => {
    expect(hasEntry(entries, "shapes", "namespace")).toBeDefined();
  });

  it("extracts Shape class", () => {
    expect(hasEntry(entries, "Shape", "class")).toBeDefined();
  });

  it("extracts Circle class", () => {
    expect(hasEntry(entries, "Circle", "class")).toBeDefined();
  });

  it("extracts template class Container", () => {
    expect(hasEntry(entries, "Container", "class")).toBeDefined();
  });

  it("skeleton text includes template declaration", () => {
    expect(text).toContain("template");
    expect(text).toContain("Container");
  });
});

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------

describe("C# (.cs)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.cs");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[C#]");
  });

  it("extracts ConsoleLogger class", () => {
    expect(hasEntry(entries, "ConsoleLogger", "class")).toBeDefined();
  });

  it("extracts class methods", () => {
    expect(hasEntry(entries, "Log", "method")).toBeDefined();
  });

  it("extracts ILogger interface", () => {
    expect(hasEntry(entries, "ILogger", "interface")).toBeDefined();
  });

  it("skeleton text includes class attribute", () => {
    expect(text).toContain("[Serializable]");
  });

  it("skeleton text includes method attribute", () => {
    expect(text).toContain("[Obsolete");
  });

  it("skeleton text includes property", () => {
    expect(text).toContain("Name");
  });
});

// ---------------------------------------------------------------------------
// Kotlin
// ---------------------------------------------------------------------------

describe("Kotlin (.kt)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.kt");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[Kotlin]");
  });

  it("extracts data class Config", () => {
    expect(hasEntry(entries, "Config", "class")).toBeDefined();
  });

  it("extracts Repository interface", () => {
    expect(hasEntry(entries, "Repository", "interface")).toBeDefined();
  });

  it("extracts UserRepository class", () => {
    expect(hasEntry(entries, "UserRepository", "class")).toBeDefined();
  });

  it("extracts class methods", () => {
    expect(hasEntry(entries, "findById", "method")).toBeDefined();
    expect(hasEntry(entries, "save", "method")).toBeDefined();
  });

  it("extracts object declaration", () => {
    expect(hasEntry(entries, "AppRegistry", "class")).toBeDefined();
  });

  it("extracts top-level function", () => {
    expect(hasEntry(entries, "initializeApp", "function")).toBeDefined();
  });

  it("skeleton text includes class declarations", () => {
    expect(text).toContain("class UserRepository");
    expect(text).toContain("object AppRegistry");
  });
});

// ---------------------------------------------------------------------------
// Swift
// ---------------------------------------------------------------------------

describe("Swift (.swift)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.swift");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[Swift]");
  });

  it("extracts Shape class", () => {
    expect(hasEntry(entries, "Shape", "class")).toBeDefined();
  });

  it("extracts Point struct", () => {
    expect(hasEntry(entries, "Point", "struct")).toBeDefined();
  });

  it("extracts Drawable protocol", () => {
    expect(hasEntry(entries, "Drawable", "protocol")).toBeDefined();
  });

  it("extracts Direction enum", () => {
    expect(hasEntry(entries, "Direction", "enum")).toBeDefined();
  });

  it("extracts top-level function", () => {
    expect(hasEntry(entries, "createShapes", "function")).toBeDefined();
  });

  it("skeleton text includes class declarations", () => {
    expect(text).toContain("class Shape");
    expect(text).toContain("struct Point");
    expect(text).toContain("protocol Drawable");
  });
});

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

describe("Ruby (.rb)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.rb");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[Ruby]");
  });

  it("extracts Animal class", () => {
    expect(hasEntry(entries, "Animal", "class")).toBeDefined();
  });

  it("extracts Dog class", () => {
    expect(hasEntry(entries, "Dog", "class")).toBeDefined();
  });

  it("extracts class methods", () => {
    expect(hasEntry(entries, "speak", "method")).toBeDefined();
    expect(hasEntry(entries, "initialize", "method")).toBeDefined();
  });

  it("extracts Animals module", () => {
    expect(hasEntry(entries, "Animals", "class")).toBeDefined();
  });

  it("skeleton text includes class hierarchy", () => {
    expect(text).toContain("class Dog");
    expect(text).toContain("module Animals");
  });
});

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

describe("PHP (.php)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.php");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[PHP]");
  });

  it("extracts User class", () => {
    expect(hasEntry(entries, "User", "class")).toBeDefined();
  });

  it("extracts class methods", () => {
    expect(hasEntry(entries, "render", "method")).toBeDefined();
    expect(hasEntry(entries, "getName", "method")).toBeDefined();
  });

  it("extracts Renderable interface", () => {
    expect(hasEntry(entries, "Renderable", "interface")).toBeDefined();
  });

  it("extracts HasTimestamps trait", () => {
    expect(hasEntry(entries, "HasTimestamps", "class")).toBeDefined();
  });

  it("skeleton text includes class declarations", () => {
    expect(text).toContain("class User");
    expect(text).toContain("interface Renderable");
    expect(text).toContain("trait HasTimestamps");
  });
});

// ---------------------------------------------------------------------------
// Scala
// ---------------------------------------------------------------------------

describe("Scala (.scala)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    const filePath = path.join(FIXTURES, "sample.scala");
    const content = await readFile(filePath, "utf-8");
    ({ text, entries } = await extractSkeletonWithEntries(filePath, content));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[Scala]");
  });

  it("extracts AppConfig object", () => {
    expect(hasEntry(entries, "AppConfig", "object")).toBeDefined();
  });

  it("extracts AppConfig class", () => {
    expect(hasEntry(entries, "AppConfig", "class")).toBeDefined();
  });

  it("extracts Repository trait", () => {
    expect(hasEntry(entries, "Repository", "trait")).toBeDefined();
  });

  it("extracts User class", () => {
    expect(hasEntry(entries, "User", "class")).toBeDefined();
  });

  it("extracts val definition", () => {
    expect(hasEntry(entries, "MaxRetries", "property")).toBeDefined();
  });

  it("extracts var definition", () => {
    expect(hasEntry(entries, "currentUser", "property")).toBeDefined();
  });

  it("extracts type definition", () => {
    expect(hasEntry(entries, "UserId", "type")).toBeDefined();
  });

  it("extracts top-level function", () => {
    expect(hasEntry(entries, "createRepository", "function")).toBeDefined();
  });

  it("skeleton text includes object and trait", () => {
    expect(text).toContain("object AppConfig");
    expect(text).toContain("trait Repository");
  });

  it("skeleton text includes imports", () => {
    expect(text).toContain("imports:");
  });
});

// ---------------------------------------------------------------------------
// Fallback for unsupported extension
// ---------------------------------------------------------------------------

describe("Fallback (unsupported extension)", () => {
  it("returns first N lines for unknown file types", async () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const { text, entries } = await extractSkeletonWithEntries("file.xyz", content, 10);
    expect(entries).toHaveLength(0);
    expect(text.split("\n")).toHaveLength(10);
    expect(text).toContain("line 1");
    expect(text).toContain("line 10");
    expect(text).not.toContain("line 11");
  });
});

// ---------------------------------------------------------------------------
// Entry line validation
// ---------------------------------------------------------------------------

describe("Entry line numbers", () => {
  it("all entries have valid startLine and endLine", async () => {
    const filePath = path.join(FIXTURES, "sample.ts");
    const content = await readFile(filePath, "utf-8");
    const lineCount = content.split("\n").length;
    const { entries } = await extractSkeletonWithEntries(filePath, content);

    for (const entry of entries) {
      expect(entry.startLine).toBeGreaterThan(0);
      expect(entry.endLine).toBeGreaterThanOrEqual(entry.startLine);
      expect(entry.endLine).toBeLessThanOrEqual(lineCount);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.kind.length).toBeGreaterThan(0);
    }
  });
});
