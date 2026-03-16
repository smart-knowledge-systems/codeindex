import { describe, it, expect } from "bun:test";
import { stripForCloud, type CloudSafeFile } from "../src/cloud/reindex";
import type { CollectedFile } from "../src/pipeline/types";

describe("cloud privacy", () => {
  const mockFile: CollectedFile = {
    relPath: "src/index.ts",
    absPath: "/home/user/project/src/index.ts",
    fileType: ".ts",
    contentHash: "abc123def456",
    content: 'const secret = "do-not-send-this";\nexport function main() {}',
    skeleton: "export function main() {}",
    skeletonEntries: JSON.stringify([{ name: "main", kind: "function", startLine: 2, endLine: 2 }]),
    importEdges: [{ source: "src/index.ts", target: "./util", kind: "import" }],
  };

  it("stripForCloud removes content and absPath", () => {
    const safe = stripForCloud(mockFile);

    // Must NOT contain sensitive fields
    expect("content" in safe).toBe(false);
    expect("absPath" in safe).toBe(false);

    // Must contain expected fields
    expect(safe.relPath).toBe("src/index.ts");
    expect(safe.contentHash).toBe("abc123def456");
    expect(safe.skeleton).toBe("export function main() {}");
    expect(safe.skeletonEntries).toBeTruthy();
    expect(safe.fileType).toBe(".ts");
    expect(safe.importEdges).toHaveLength(1);
  });

  it("stripForCloud output serializes without content or absPath", () => {
    const safe = stripForCloud(mockFile);
    const json = JSON.stringify(safe);

    expect(json).not.toContain("do-not-send-this");
    expect(json).not.toContain("/home/user/project");
    expect(json).not.toContain('"content"');
    expect(json).not.toContain('"absPath"');
  });

  it("preserves all safe fields accurately", () => {
    const safe: CloudSafeFile = stripForCloud(mockFile);

    expect(safe).toEqual({
      relPath: "src/index.ts",
      contentHash: "abc123def456",
      skeleton: "export function main() {}",
      skeletonEntries: mockFile.skeletonEntries,
      fileType: ".ts",
      importEdges: mockFile.importEdges,
    });
  });
});
