// YNAB MCP server — entry point.
//
// Exposes YNAB data to Claude as MCP "tools". Built incrementally as a learning
// project. This server talks to Claude over stdio (stdin/stdout), so stdout is
// the JSON message channel — NEVER write to it directly. Use console.error
// (stderr) for any human-facing logging.
//
// After the Phase 3 split this file is a THIN ENTRY: it wires the pieces
// together and connects the transport, nothing more. The actual work lives in
// focused modules — lib/ (pure helpers), ynab/ (the API client, cache, lookups),
// and tools/ (the tool registrations). Each register*() function takes the
// `server` and the `api` client as parameters (dependency injection), so no
// module reaches for a global client.
//
// Note the ".js" extensions on the imports: with tsconfig "module": "nodenext",
// ESM imports reference the compiled ".js" name even though the source is
// TypeScript. This is the Node ESM rule, not a typo.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createYnabClient } from "./ynab/client.js";
import { registerReadTools } from "./tools/read.js";
import { registerTransactionWriteTools } from "./tools/transactions-write.js";
import { registerImportTools } from "./tools/transactions-import.js";

// Build the YNAB API client (token check happens inside; it exits if absent).
const api = createYnabClient(process.env.YNAB_TOKEN);

// name/version identify this server to Claude during the connection handshake.
// `instructions` is a server-level hint the host can show the model before any
// tool call — the one place to state the safety model once, rather than
// repeating it in every tool description.
//
// Tool naming: every tool is snake_case `verb_noun` (list_budgets,
// update_transaction). That's the deliberate MCP convention here — keep new
// tools (e.g. Milestone 5's category tools) in the same style; don't drift to
// camelCase.
const server = new McpServer(
  {
    name: "ynab-mcp-server",
    version: "0.1.0",
  },
  {
    instructions:
      "Tools for the user's YNAB budget. Reads are safe; writes mutate " +
      "bookkeeping — not real money. Bulk writes default to dryRun (preview " +
      "only) — pass dryRun:false to commit.",
  },
);

// Register the tools, grouped by domain. The api client is injected into each.
registerReadTools(server, api);
registerTransactionWriteTools(server, api);
registerImportTools(server, api);

// --- Connect over stdio and start serving ----------------------------------
// StdioServerTransport = Claude launches this file as a child process and
// exchanges JSON messages over stdin/stdout. After connect(), the process stays
// alive listening — it does NOT exit. Log status to stderr only.
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("YNAB MCP server running on stdio.");
}

main().catch((err) => {
  console.error("Fatal error starting YNAB MCP server:", err);
  process.exit(1);
});
