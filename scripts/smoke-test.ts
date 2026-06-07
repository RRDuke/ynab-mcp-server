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

// Small helper: call a tool and print the first text block it returns.
// callTool's result.content is the { type, text }[] array our server built.
async function callAndPrint(
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`);
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])
    .map((c) => c.text)
    .join("\n");
  console.log(text);
  return text;
}

// 2. list_budgets (no args) — and scrape the first budget id out of the text
//    so the argument-taking tools below have a real id to work with.
const budgetsText = await callAndPrint("list_budgets");
const budgetId = budgetsText.match(/id: ([0-9a-f-]+)/i)?.[1];
if (!budgetId) {
  console.error("\nCould not find a budget id to test the other tools with.");
  await client.close();
  process.exit(1);
}
console.log(`\n>>> Using budgetId ${budgetId} for the remaining tools.`);

// 3. The three argument-taking read tools, against the real budget.
await callAndPrint("list_accounts", { budgetId });
await callAndPrint("list_categories", { budgetId });
await callAndPrint("list_transactions", { budgetId });

await client.close(); // shuts down the child server process
