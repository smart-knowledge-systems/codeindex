import { describe, it, expect, beforeAll } from "bun:test";
import { readdir, readFile } from "fs/promises";
import path from "path";
import { initParser, extractSkeletonWithEntries } from "../src/index/skeleton";

// Grammar or runtime upgrades can change node shapes without failing the
// targeted assertions in skeleton.test.ts; a snapshot diff makes that loud.

const FIXTURES = path.join(import.meta.dir, "fixtures");
const fixtures = (await readdir(FIXTURES)).sort();

beforeAll(async () => {
  await initParser();
});

describe("skeleton golden output", () => {
  for (const name of fixtures) {
    it(name, async () => {
      const filePath = path.join(FIXTURES, name);
      const result = await extractSkeletonWithEntries(filePath, await readFile(filePath, "utf-8"));
      expect(result.entries.length).toBeGreaterThan(0);
      expect(result).toMatchSnapshot();
    });
  }
});
