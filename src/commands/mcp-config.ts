import { flag, type ParsedArgs } from "../cli";

export function cmdMcpConfig(parsed: ParsedArgs): void {
  const transport = flag(parsed, "transport") ?? "stdio";
  const port = flag(parsed, "port") ?? "3100";

  if (transport === "sse") {
    const config = {
      mcpServers: {
        codeindex: {
          url: `http://localhost:${port}/sse`,
        },
      },
    };
    console.log(JSON.stringify(config, null, 2));
  } else {
    const config = {
      mcpServers: {
        codeindex: {
          command: "codeindex",
          args: ["mcp"],
        },
      },
    };
    console.log(JSON.stringify(config, null, 2));
  }
}
