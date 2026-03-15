import { describe, it, expect, afterEach } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server";

// ---------------------------------------------------------------------------
// Helpers — guaranteed cleanup via try/finally
// ---------------------------------------------------------------------------

interface McpFixture {
  client: Client;
  mcpServer: ReturnType<typeof createMcpServer>;
  cleanup: () => Promise<void>;
}

async function createFixture(repoRoot: string): Promise<McpFixture> {
  const mcpServer = createMcpServer(repoRoot);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    mcpServer,
    cleanup: async () => {
      await client.close();
      await mcpServer.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP server", () => {
  const fixtures: McpFixture[] = [];

  afterEach(async () => {
    for (const f of fixtures) {
      await f.cleanup();
    }
    fixtures.length = 0;
  });

  it("lists all registered tools", async () => {
    const fixture = await createFixture(process.cwd());
    fixtures.push(fixture);

    const { tools } = await fixture.client.listTools();
    const toolNames = tools.map((t) => t.name).sort();

    // Core tools always present
    expect(toolNames).toContain("search");
    expect(toolNames).toContain("status");
    expect(toolNames).toContain("drift");
    expect(toolNames).toContain("intent");
    // M5 architecture intelligence tools
    expect(toolNames).toContain("findCallers");
    expect(toolNames).toContain("traceImportChain");
    expect(toolNames.length).toBeGreaterThanOrEqual(15);
  });

  // Error-path tests: validate that the MCP server handles unindexed repos
  // gracefully rather than crashing. These are consolidated into a single
  // parameterized test to reduce redundancy while covering both tools.
  it.each([
    { tool: "search", args: { query: "test query" } },
    { tool: "status", args: {} },
  ])("$tool tool returns content (not crash) for unindexed repo", async ({ tool, args }) => {
    const fixture = await createFixture("/tmp/nonexistent-repo");
    fixtures.push(fixture);

    const result = await fixture.client.callTool({ name: tool, arguments: args });
    // McpServer wraps errors as isError content rather than throwing
    expect(result.content).toBeDefined();
  });

  it("search tool has correct input schema", async () => {
    const fixture = await createFixture(process.cwd());
    fixtures.push(fixture);

    const { tools } = await fixture.client.listTools();
    const searchTool = tools.find((t) => t.name === "search");

    expect(searchTool).toBeDefined();
    expect(searchTool!.description).toContain("Semantic code search");

    const props = searchTool!.inputSchema?.properties as Record<string, unknown>;
    expect(props).toBeDefined();
    expect(props.query).toBeDefined();
    expect(props.topN).toBeDefined();
    expect(props.minScore).toBeDefined();
    expect(props.lang).toBeDefined();
    expect(props.dir).toBeDefined();
    expect(props.since).toBeDefined();
    expect(props.scope).toBeDefined();
    expect(props.explain).toBeDefined();
  });
});
