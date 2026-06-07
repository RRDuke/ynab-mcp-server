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

// --- 6. Register the read-only "list_categories" tool ----------------------
// Nested data: YNAB returns category_groups, and each group holds its own
// categories[]. So we iterate two levels — groups outside, categories inside.
// We skip hidden/deleted at both levels. Note: YNAB's bookkeeping group
// "Internal Master Category" (holding "Inflow: Ready to Assign",
// "Uncategorized", etc.) is NOT flagged hidden, so it currently shows through.
// Filter it out by name here if we decide it's noise for the caller.
server.registerTool(
  "list_categories",
  {
    title: "List categories in a YNAB budget",
    description:
      "List the budget categories grouped by category group, with each " +
      "category's budgeted, activity, and balance amounts for the current " +
      "month. Hidden and deleted items are omitted. Read-only. Use " +
      "list_budgets first to find the budgetId.",
    inputSchema: {
      budgetId: z
        .string()
        .describe("The id of the budget to list categories for."),
    },
  },
  async ({ budgetId }) => {
    const response = await ynabAPI.categories.getCategories(budgetId);
    const groups = response.data.category_groups.filter(
      (g) => !g.hidden && !g.deleted,
    );

    // Build one block per group: a header line, then its categories indented.
    const blocks = groups
      .map((group) => {
        const categories = group.categories.filter(
          (c) => !c.hidden && !c.deleted,
        );
        if (categories.length === 0) return null; // nothing visible to show

        const catLines = categories
          .map(
            (c) =>
              `  - ${c.name}: budgeted ${formatMilliunits(c.budgeted)}, ` +
              `activity ${formatMilliunits(c.activity)}, ` +
              `balance ${formatMilliunits(c.balance)}`,
          )
          .join("\n");
        return `${group.name}\n${catLines}`;
      })
      .filter((block) => block !== null);

    const text =
      blocks.length > 0
        ? blocks.join("\n\n")
        : "No visible categories found in this budget.";

    return { content: [{ type: "text", text }] };
  },
);

// --- Transaction cache (YNAB delta sync) -----------------------------------
// We cache each budget's full transaction set so paging and filters don't
// re-fetch thousands of rows. Per budget we store:
//   serverKnowledge — YNAB's cursor: the point our cache is current to. Handed
//                     back on the next request to fetch only what changed since.
//   byId            — the transactions themselves, keyed by id, so a changed
//                     row is an overwrite and a deleted row is a delete (O(1)).
interface TransactionCacheEntry {
  serverKnowledge: number;
  byId: Map<string, ynab.TransactionDetail>;
}
// Keyed by budgetId — each budget syncs independently.
const transactionCache = new Map<string, TransactionCacheEntry>();

// Returns the complete, current transaction set for a budget; callers apply
// their own date/type/paging filters on top. forceRefresh discards the cache
// and re-downloads everything from scratch.
async function getAllTransactions(
  budgetId: string,
  forceRefresh: boolean,
): Promise<ynab.TransactionDetail[]> {
  const cached = forceRefresh ? undefined : transactionCache.get(budgetId);

  // Fetch the WHOLE budget (no sinceDate/type) so the cache stays complete and
  // delta sync stays coherent. cursor undefined on the first call -> full set.
  const response = await ynabAPI.transactions.getTransactions(
    budgetId,
    undefined,
    undefined,
    cached?.serverKnowledge,
  );

  // Merge the delta into the cache: drop deletions, upsert everything else.
  const byId = cached?.byId ?? new Map<string, ynab.TransactionDetail>();
  for (const txn of response.data.transactions) {
    if (txn.deleted) byId.delete(txn.id);
    else byId.set(txn.id, txn);
  }

  // Observability (stderr only): full fetch vs cheap delta.
  console.error(
    cached
      ? `[cache] ${budgetId}: delta merged ${response.data.transactions.length} change(s) -> ${byId.size} total`
      : `[cache] ${budgetId}: full fetch of ${byId.size} transaction(s)`,
  );

  transactionCache.set(budgetId, {
    serverKnowledge: response.data.server_knowledge,
    byId,
  });
  return [...byId.values()];
}

// --- 7. Register the read-only "list_transactions" tool --------------------
// Reads from the delta-synced cache (getAllTransactions) and applies ALL
// filtering client-side: sinceDate (date string compare), type ('unapproved'
// is exact; 'uncategorized' is approximated as a row needing a category — not
// categorized, not a transfer, not a split parent), and limit/offset paging.
// The response always reports the window shown out of the matching total.
const DEFAULT_TRANSACTION_LIMIT = 50; // used when Claude omits `limit`
const MAX_TRANSACTION_LIMIT = 200; // ceiling on any single response
server.registerTool(
  "list_transactions",
  {
    title: "List transactions in a YNAB budget",
    description:
      "List transactions in a given YNAB budget, newest first, showing each " +
      "one's date, payee, category, amount, and account. Optional filters: " +
      "sinceDate (on or after a date) and type (uncategorized or unapproved). " +
      "Page through results with limit and offset; the response reports the " +
      `window shown out of the total (default limit ${DEFAULT_TRANSACTION_LIMIT}, ` +
      `max ${MAX_TRANSACTION_LIMIT}). Read-only. Use list_budgets first to find ` +
      "the budgetId.",
    inputSchema: {
      budgetId: z
        .string()
        .describe("The id of the budget to list transactions for."),
      sinceDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "sinceDate must be ISO format YYYY-MM-DD")
        .optional()
        .describe(
          "Only include transactions on or after this date (YYYY-MM-DD). " +
            "Omit to return the most recent transactions overall.",
        ),
      type: z
        .enum(["uncategorized", "unapproved"])
        .optional()
        .describe(
          "Optionally return only 'uncategorized' or only 'unapproved' " +
            "transactions. Omit to return all types.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_TRANSACTION_LIMIT)
        .default(DEFAULT_TRANSACTION_LIMIT)
        .describe(
          `Max number of transactions to return (1-${MAX_TRANSACTION_LIMIT}). ` +
            `Defaults to ${DEFAULT_TRANSACTION_LIMIT}.`,
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe(
          "How many transactions to skip from the newest, for paging. " +
            "Defaults to 0.",
        ),
      refresh: z
        .boolean()
        .default(false)
        .describe(
          "Force a full re-fetch from YNAB instead of the usual cheap delta " +
            "sync. Rarely needed; defaults to false.",
        ),
    },
  },
  async ({ budgetId, sinceDate, type, limit, offset, refresh }) => {
    // One delta-synced fetch returns the complete, current set; filter locally.
    const all = await getAllTransactions(budgetId, refresh);

    let filtered = all;
    if (sinceDate) filtered = filtered.filter((t) => t.date >= sinceDate);
    if (type === "unapproved") {
      filtered = filtered.filter((t) => !t.approved);
    } else if (type === "uncategorized") {
      // Approximates YNAB's server-side "uncategorized": a row that still needs
      // a category — not yet categorized, not a transfer, not a split parent.
      filtered = filtered.filter(
        (t) =>
          !t.category_id &&
          !t.transfer_account_id &&
          t.subtransactions.length === 0,
      );
    }

    // Newest first (ISO dates sort correctly as strings), then page.
    const sorted = [...filtered].sort((a, b) => b.date.localeCompare(a.date));
    const total = sorted.length;
    const page = sorted.slice(offset, offset + limit);

    const lines = page
      .map((t) => {
        const payee = t.payee_name ?? "(no payee)";
        const category = t.category_name ?? "(uncategorized)";
        return (
          `- ${t.date} | ${payee} | ${category} | ` +
          `${formatMilliunits(t.amount)} [${t.account_name}]`
        );
      })
      .join("\n");

    // Describe the active filters for the header line.
    const activeFilters = [
      sinceDate ? `since ${sinceDate}` : null,
      type ? `type=${type}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const scope = activeFilters ? ` (${activeFilters})` : "";

    let text: string;
    if (total === 0) {
      text = `No transactions found${scope}.`;
    } else if (page.length === 0) {
      text = `Offset ${offset} is past the ${total} matching transaction(s)${scope}.`;
    } else {
      const start = offset + 1;
      const end = offset + page.length;
      text = `Transactions${scope} — showing ${start}-${end} of ${total}:\n${lines}`;
    }

    return { content: [{ type: "text", text }] };
  },
);

// --- 8. Connect over stdio and start serving -------------------------------
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
