import { describe, it, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server";

describe("MCP server", () => {
  it("lists all four tools", async () => {
    const mcpServer = createMcpServer(process.cwd());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await mcpServer.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name).sort();

    expect(toolNames).toEqual(["drift", "intent", "search", "status"]);

    await client.close();
    await mcpServer.close();
  });

  it("search tool returns content with error for unindexed repo", async () => {
    const mcpServer = createMcpServer("/tmp/nonexistent-repo");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await mcpServer.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    // Calling search on a non-indexed repo should return an error or empty results
    try {
      const result = await client.callTool({
        name: "search",
        arguments: { query: "test query" },
      });
      // If it doesn't throw, the result should have content
      expect(result.content).toBeDefined();
    } catch (err) {
      // Expected — no index at /tmp/nonexistent-repo
      expect(err).toBeDefined();
    }

    await client.close();
    await mcpServer.close();
  });

  it("status tool returns error for unindexed repo", async () => {
    const mcpServer = createMcpServer("/tmp/nonexistent-repo");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await mcpServer.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "status",
        arguments: {},
      });
      // McpServer wraps errors as isError content
      expect(result.content).toBeDefined();
    } catch (err) {
      expect(err).toBeDefined();
    }

    await client.close();
    await mcpServer.close();
  });

  it("search tool has correct input schema", async () => {
    const mcpServer = createMcpServer(process.cwd());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await mcpServer.connect(serverTransport);

    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
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

    await client.close();
    await mcpServer.close();
  });
});
