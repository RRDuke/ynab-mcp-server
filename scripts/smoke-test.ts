// Throwaway smoke test — acts as a tiny "Claude" to prove the server works
// end to end before we wire up the real Claude. Run with:
//   npx tsx smoke-test.ts
// Delete it once we've confirmed the green light.
//
// NOTE: console.log is fine HERE — this is the CLIENT; its stdout is our
// terminal, not an MCP protocol channel.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The transport launches our server as a child process — the SAME way Claude
// will. node loads the token from .env via --env-file; we pass nothing secret.
const transport = new StdioClientTransport({
  command: "node",
  args: ["--env-file=.env", "dist/server.js"],
});

const client = new Client({ name: "smoke-test", version: "0.0.1" });

await client.connect(transport); // spawns server + does the MCP handshake
console.log("Connected. Asking the server what tools it has...\n");

// 1. Discovery — exactly what Claude does to learn the server's capabilities.
const { tools } = await client.listTools();
console.log(
  "Tools advertised:",
  tools.map((t) => t.name),
);

// 2. Invoke the tool — the real end-to-end test against YNAB's servers.
console.log("\nCalling list_budgets...\n");
const result = await client.callTool({
  name: "list_budgets",
  arguments: {},
});

// result.content is the { type, text } array our server returned.
console.log(JSON.stringify(result.content, null, 2));

await client.close(); // shuts down the child server process
