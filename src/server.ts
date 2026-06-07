// YNAB MCP server — entry point.
//
// Exposes YNAB data to Claude as MCP "tools". Built incrementally as a
// learning project. This server talks to Claude over stdio (stdin/stdout),
// so stdout is the JSON message channel — NEVER write to it directly. Use
// console.error (stderr) for any human-facing logging.

// Note the ".js" extensions on the SDK subpath imports: with tsconfig
// "module": "nodenext", ESM imports reference the compiled ".js" name even
// though the SDK source is TypeScript. This is the Node ESM rule, not a typo.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as ynab from "ynab";

// --- 1. Read the secret token from the environment -------------------------
// The real value lives only in the gitignored .env file, loaded via Node's
// native --env-file flag at run time (no "dotenv" dependency needed). Fail
// fast with a clear message if it's absent.
const token = process.env.YNAB_TOKEN;
if (!token) {
  console.error(
    "Missing YNAB_TOKEN. Create a .env file with YNAB_TOKEN=<your token> " +
      "and run with --env-file=.env (see package.json scripts).",
  );
  process.exit(1);
}

// --- 2. Create the YNAB API client -----------------------------------------
// Hand the token to the SDK once; every API call below reuses it. The token
// grants full read/write to every budget and stays server-side — Claude only
// ever sees tool inputs/outputs, never this credential.
const ynabAPI = new ynab.API(token);

// --- 3. Create the MCP server ----------------------------------------------
// name/version identify this server to Claude during the connection handshake.
const server = new McpServer({
  name: "ynab-mcp-server",
  version: "0.1.0",
});

// --- 4. Register the read-only "list_budgets" tool -------------------------
// (A) name + config = the Claude-facing interface. The description is how
//     Claude decides WHEN to call this tool, so it's worth writing clearly.
//     No inputSchema: this tool takes no arguments.
// (B) the async callback = the YNAB logic that runs when Claude invokes it.
//     It must return the MCP shape { content: [{ type: "text", text }] }.
server.registerTool(
  "list_budgets",
  {
    title: "List YNAB budgets",
    description:
      "List all of the user's YNAB budgets (plans), returning each one's " +
      "name and id. Read-only.",
  },
  async () => {
    // YNAB renamed "budgets" -> "plans" in v4; the list lives at data.plans.
    const response = await ynabAPI.plans.getPlans();
    const plans = response.data.plans;

    const lines = plans.map((p) => `- ${p.name} (id: ${p.id})`).join("\n");
    const text =
      plans.length > 0
        ? `Found ${plans.length} budget(s):\n${lines}`
        : "No budgets found for this token.";

    return { content: [{ type: "text", text }] };
  },
);

// --- 5. Connect over stdio and start serving -------------------------------
// StdioServerTransport = Claude launches this file as a child process and
// exchanges JSON messages over stdin/stdout. After connect(), the process
// stays alive listening — it does NOT exit. Log status to stderr only.
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("YNAB MCP server running on stdio.");
}

main().catch((err) => {
  console.error("Fatal error starting YNAB MCP server:", err);
  process.exit(1);
});
