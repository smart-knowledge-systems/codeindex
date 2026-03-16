import { describe, it, expect, beforeAll } from "bun:test";
import { readFile } from "fs/promises";
import path from "path";
import { initParser, extractSkeletonWithEntries } from "../src/index/skeleton";
import type { SkeletonEntry } from "../src/search/types";

const FIXTURES = path.join(import.meta.dir, "fixtures");

beforeAll(async () => {
  await initParser();
});

// -- Helpers ------------------------------------------------------------------

/** Curried predicate: matches an entry by name and kind. */
const matchEntry =
  (name: string, kind: string) =>
  (e: SkeletonEntry): boolean =>
    e.name === name && e.kind === kind;

/** Find an entry by name and kind in a list. */
const findEntry = (entries: SkeletonEntry[], name: string, kind: string) =>
  entries.find(matchEntry(name, kind));

/** Load a fixture and extract its skeleton + entries. */
const loadFixture = async (filename: string) => {
  const filePath = path.join(FIXTURES, filename);
  const content = await readFile(filePath, "utf-8");
  return extractSkeletonWithEntries(filePath, content);
};

// =============================================================================
// Core Language Tests
//
// Detailed tests for languages with complex extraction patterns: decorators,
// generics, docstrings, traits, impl blocks, and nested structures.
// =============================================================================

// ---------------------------------------------------------------------------
// TypeScript — primary language, most construct coverage
// ---------------------------------------------------------------------------

describe("TypeScript (.ts)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    ({ text, entries } = await loadFixture("sample.ts"));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[TypeScript]");
  });

  it("extracts functions with valid line ranges", () => {
    const e = findEntry(entries, "loadConfig", "function");
    expect(e).toBeDefined();
    expect(e!.startLine).toBeGreaterThan(0);
    expect(e!.endLine).toBeGreaterThanOrEqual(e!.startLine);
  });

  it("extracts classes and methods", () => {
    expect(findEntry(entries, "Server", "class")).toBeDefined();
    expect(findEntry(entries, "start", "method")).toBeDefined();
  });

  it("extracts interfaces", () => {
    expect(findEntry(entries, "Config", "interface")).toBeDefined();
    expect(text).toContain("interface Config");
  });

  it("extracts type aliases", () => {
    expect(findEntry(entries, "UserId", "type")).toBeDefined();
    expect(text).toContain("type UserId = string | number");
  });

  it("extracts enums with members", () => {
    expect(findEntry(entries, "LogLevel", "enum")).toBeDefined();
    expect(text).toContain("enum LogLevel");
    expect(text).toContain("members:");
  });

  it("skeleton text includes imports", () => {
    expect(text).toContain("imports:");
  });
});

// ---------------------------------------------------------------------------
// Python — decorators, docstrings, dataclasses
// ---------------------------------------------------------------------------

describe("Python (.py)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    ({ text, entries } = await loadFixture("sample.py"));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[Python]");
  });

  it("extracts functions and classes", () => {
    expect(findEntry(entries, "create_pool", "function")).toBeDefined();
    expect(findEntry(entries, "Database", "class")).toBeDefined();
  });

  it("extracts class methods", () => {
    expect(findEntry(entries, "__init__", "method")).toBeDefined();
    expect(findEntry(entries, "connect", "method")).toBeDefined();
    expect(findEntry(entries, "query", "method")).toBeDefined();
  });

  it("skeleton text includes docstrings", () => {
    expect(text).toContain("Manages database connections");
  });

  it("extracts decorated classes and methods", () => {
    expect(findEntry(entries, "Config", "class")).toBeDefined();
    expect(text).toContain("@dataclass");
    expect(text).toContain("class Config");
    expect(text).toContain("@property");
    expect(text).toContain("is_connected");
  });
});

// ---------------------------------------------------------------------------
// Go — structs, interfaces, const/var groups
// ---------------------------------------------------------------------------

describe("Go (.go)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    ({ text, entries } = await loadFixture("sample.go"));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[Go]");
  });

  it("extracts structs and interfaces", () => {
    expect(findEntry(entries, "Router", "struct")).toBeDefined();
    expect(findEntry(entries, "Handler", "interface")).toBeDefined();
  });

  it("extracts functions and methods", () => {
    expect(findEntry(entries, "NewRouter", "function")).toBeDefined();
    expect(findEntry(entries, "Handle", "method")).toBeDefined();
    expect(findEntry(entries, "hello", "function")).toBeDefined();
  });

  it("skeleton text includes const and var groups", () => {
    expect(text).toContain("const (");
    expect(text).toContain("MaxRetries");
    expect(text).toContain("var (");
    expect(text).toContain("DefaultRouter");
  });
});

// ---------------------------------------------------------------------------
// Rust — traits, impl blocks, derive attributes
// ---------------------------------------------------------------------------

describe("Rust (.rs)", () => {
  let text: string;
  let entries: SkeletonEntry[];

  beforeAll(async () => {
    ({ text, entries } = await loadFixture("sample.rs"));
  });

  it("produces non-empty skeleton text", () => {
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("[Rust]");
  });

  it("extracts structs and impl blocks", () => {
    expect(findEntry(entries, "MemoryStore", "struct")).toBeDefined();
    expect(findEntry(entries, "MemoryStore", "impl")).toBeDefined();
  });

  it("extracts impl methods and top-level functions", () => {
    expect(findEntry(entries, "get", "function")).toBeDefined();
    expect(findEntry(entries, "set", "function")).toBeDefined();
    expect(findEntry(entries, "create_store", "function")).toBeDefined();
  });

  it("extracts traits", () => {
    expect(findEntry(entries, "Storage", "trait")).toBeDefined();
  });

  it("skeleton text includes derive attribute", () => {
    expect(text).toContain("#[derive(Debug, Clone)]");
  });
});

// =============================================================================
// Smoke Tests — Other Supported Languages
//
// Parameterized tests verify basic extraction works for each language without
// duplicating detailed construct-level assertions. Each entry defines the
// fixture, expected header tag, and a representative entry to find.
// =============================================================================

const languageSmokeTests: Array<{
  label: string;
  fixture: string;
  headerTag: string;
  sampleEntry: { name: string; kind: string };
  skeletonContains?: string[];
}> = [
  {
    label: "TSX (.tsx)",
    fixture: "sample.tsx",
    headerTag: "[TSX]",
    sampleEntry: { name: "Button", kind: "function" },
  },
  {
    label: "JavaScript (.js)",
    fixture: "sample.js",
    headerTag: "[JavaScript]",
    sampleEntry: { name: "Logger", kind: "class" },
  },
  {
    label: "Java (.java)",
    fixture: "sample.java",
    headerTag: "[Java]",
    sampleEntry: { name: "UserService", kind: "class" },
    skeletonContains: ["@Override", "@Deprecated"],
  },
  {
    label: "C (.c)",
    fixture: "sample.c",
    headerTag: "[C]",
    sampleEntry: { name: "point_new", kind: "function" },
    skeletonContains: ["typedef struct Point"],
  },
  {
    label: "C++ (.cpp)",
    fixture: "sample.cpp",
    headerTag: "[C++]",
    sampleEntry: { name: "Shape", kind: "class" },
    skeletonContains: ["template", "Container"],
  },
  {
    label: "C# (.cs)",
    fixture: "sample.cs",
    headerTag: "[C#]",
    sampleEntry: { name: "ConsoleLogger", kind: "class" },
    skeletonContains: ["[Serializable]"],
  },
  {
    label: "Kotlin (.kt)",
    fixture: "sample.kt",
    headerTag: "[Kotlin]",
    sampleEntry: { name: "UserRepository", kind: "class" },
    skeletonContains: ["object AppRegistry"],
  },
  {
    label: "Swift (.swift)",
    fixture: "sample.swift",
    headerTag: "[Swift]",
    sampleEntry: { name: "Shape", kind: "class" },
    skeletonContains: ["protocol Drawable", "typealias ShapeList"],
  },
  {
    label: "Ruby (.rb)",
    fixture: "sample.rb",
    headerTag: "[Ruby]",
    sampleEntry: { name: "Animal", kind: "class" },
    skeletonContains: ["attr_reader", "module Animals"],
  },
  {
    label: "PHP (.php)",
    fixture: "sample.php",
    headerTag: "[PHP]",
    sampleEntry: { name: "User", kind: "class" },
    skeletonContains: ["enum Status", "trait HasTimestamps"],
  },
  {
    label: "Scala (.scala)",
    fixture: "sample.scala",
    headerTag: "[Scala]",
    sampleEntry: { name: "Repository", kind: "trait" },
    skeletonContains: ["object AppConfig", "trait Repository"],
  },
  {
    label: "Elixir (.ex)",
    fixture: "sample.ex",
    headerTag: "[Elixir]",
    sampleEntry: { name: "Animals.Dog", kind: "class" },
    skeletonContains: ["defmodule Animals.Dog", "defprotocol Describable"],
  },
  {
    label: "Lua (.lua)",
    fixture: "sample.lua",
    headerTag: "[Lua]",
    sampleEntry: { name: "M.new", kind: "function" },
  },
  {
    label: "Zig (.zig)",
    fixture: "sample.zig",
    headerTag: "[Zig]",
    sampleEntry: { name: "Point", kind: "struct" },
    skeletonContains: ["pub struct Point", "enum Direction", "union Value"],
  },
];

describe.each(languageSmokeTests)(
  "$label",
  ({ fixture, headerTag, sampleEntry, skeletonContains }) => {
    let text: string;
    let entries: SkeletonEntry[];

    beforeAll(async () => {
      ({ text, entries } = await loadFixture(fixture));
    });

    it("produces non-empty skeleton with correct header", () => {
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain(headerTag);
    });

    it("extracts at least one expected entry", () => {
      expect(findEntry(entries, sampleEntry.name, sampleEntry.kind)).toBeDefined();
    });

    if (skeletonContains) {
      it("skeleton text contains expected constructs", () => {
        skeletonContains.forEach((s) => expect(text).toContain(s));
      });
    }
  },
);

// =============================================================================
// Edge Cases
// =============================================================================

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

describe("Entry line numbers", () => {
  it("all entries have valid startLine and endLine", async () => {
    const filePath = path.join(FIXTURES, "sample.ts");
    const content = await readFile(filePath, "utf-8");
    const lineCount = content.split("\n").length;
    const { entries } = await extractSkeletonWithEntries(filePath, content);

    entries.forEach((entry) => {
      expect(entry.startLine).toBeGreaterThan(0);
      expect(entry.endLine).toBeGreaterThanOrEqual(entry.startLine);
      expect(entry.endLine).toBeLessThanOrEqual(lineCount);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.kind.length).toBeGreaterThan(0);
    });
  });
});
