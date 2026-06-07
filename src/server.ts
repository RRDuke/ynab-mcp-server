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
import { z } from "zod";

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

// --- Helpers ---------------------------------------------------------------
// YNAB stores every monetary amount as an integer "milliunit": 1000 = $1.00,
// so -43210 milliunits = -$43.21. Divide by 1000 and format as currency once,
// here, so the tools below never repeat this conversion.
//
// Intl.NumberFormat is a built-in JS API (the ECMAScript Internationalization
// API) — no import, no dependency. "en-US" picks the grouping/decimal style
// (1,234.56) and { style: "currency", currency: "USD" } adds the $ and the
// fixed 2 decimals, including correct negative signs. Currency is hardcoded to
// USD for now; YNAB budgets carry their own currency_format we can honor later.
function formatMilliunits(milliunits: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(milliunits / 1000);
}

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

// --- 5. Register the read-only "list_accounts" tool ------------------------
// First tool that takes an argument. inputSchema is a "Zod raw shape" (a plain
// object of validators, NOT z.object({...})). The SDK validates Claude's input
// against it before the callback runs and passes the parsed args in as the
// first parameter — so { budgetId } below is already known to be a string.
server.registerTool(
  "list_accounts",
  {
    title: "List accounts in a YNAB budget",
    description:
      "List the accounts in a given YNAB budget, with each account's name, " +
      "type, and current balance. Closed accounts are omitted. Read-only. " +
      "Use list_budgets first to find the budgetId.",
    inputSchema: {
      budgetId: z
        .string()
        .describe("The id of the budget to list accounts for."),
    },
  },
  async ({ budgetId }) => {
    const response = await ynabAPI.accounts.getAccounts(budgetId);
    // Skip accounts the user has closed — they're clutter, not current data.
    const accounts = response.data.accounts.filter((a) => !a.closed);

    const lines = accounts
      .map((a) => `- ${a.name} [${a.type}]: ${formatMilliunits(a.balance)}`)
      .join("\n");
    const text =
      accounts.length > 0
        ? `Found ${accounts.length} open account(s):\n${lines}`
        : "No open accounts found in this budget.";

    return { content: [{ type: "text", text }] };
  },
);

// --- 6. Connect over stdio and start serving -------------------------------
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
