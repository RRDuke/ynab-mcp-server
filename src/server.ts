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

// The inverse of formatMilliunits, for the WRITE path: Claude thinks in dollars
// (43.21), YNAB stores integer milliunits (43210). Multiplying by 1000 isn't
// enough — binary floating point can't represent 43.21 exactly, so
// 43.21 * 1000 === 43209.99999999999, not 43210. Math.round snaps to the
// nearest whole milliunit, which is what YNAB requires. Negative amounts
// (outflows) round correctly too: Math.round(-43209.9999) === -43210.
function dollarsToMilliunits(dollars: number): number {
  return Math.round(dollars * 1000);
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
      .map(
        (a) =>
          `- ${a.name} [${a.type}]: ${formatMilliunits(a.balance)} (id: ${a.id})`,
      )
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
              `  - ${c.name} (id: ${c.id}): budgeted ${formatMilliunits(c.budgeted)}, ` +
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
          `${formatMilliunits(t.amount)} [${t.account_name}] (id: ${t.id})`
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

// --- 8. Register the write tool "update_transaction" -----------------------
// Our FIRST tool that MUTATES data. It edits one existing transaction — the
// core of the cleanup workflow (categorize a row, then "clear" it to mark it
// vetted). Every editable field is optional; you send only what you're
// changing. The write goes through updateTransaction(budgetId, txnId, body),
// where `body` is the PutTransactionWrapper: YNAB wants the fields nested under
// a `transaction:` key, not passed loose. The MCP client prompts you to
// approve every call, and we echo each changed field old -> new so the edit is
// auditable in the conversation.
server.registerTool(
  "update_transaction",
  {
    title: "Update a single YNAB transaction",
    description:
      "Edit one existing transaction in a YNAB budget — typically to assign a " +
      "category and then mark it cleared once vetted. Provide budgetId and " +
      "transactionId to locate the row, plus any fields to change; omitted " +
      "fields are left as-is. Amount is in dollars (e.g. -43.21 for a $43.21 " +
      "outflow). MUTATES data. Use list_transactions to find the transactionId " +
      "and list_categories to find a categoryId.",
    inputSchema: {
      budgetId: z
        .string()
        .describe("The id of the budget containing the transaction."),
      transactionId: z
        .string()
        .describe("The id of the transaction to update."),
      categoryId: z
        .string()
        .optional()
        .describe(
          "Assign this category (a category id from list_categories). " +
            "Cannot be changed on a split transaction.",
        ),
      payeeName: z
        .string()
        .optional()
        .describe(
          "Set the payee name. Resolves to an existing payee or creates one.",
        ),
      memo: z.string().optional().describe("Set the transaction memo/note."),
      amount: z
        .number()
        .optional()
        .describe(
          "Set the amount in DOLLARS (negative for outflow, e.g. -43.21). " +
            "Converted to YNAB milliunits internally.",
        ),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO format YYYY-MM-DD")
        .optional()
        .describe("Set the transaction date (YYYY-MM-DD). No future dates."),
      approved: z
        .boolean()
        .optional()
        .describe("Mark the transaction approved (true) or unapproved (false)."),
      cleared: z
        .enum(["cleared", "uncleared", "reconciled"])
        .optional()
        .describe(
          "Set the cleared status. Mark 'cleared' once a transaction has been " +
            "vetted and needs no further review.",
        ),
      flagColor: z
        .enum(["red", "orange", "yellow", "green", "blue", "purple"])
        .optional()
        .describe("Set the flag color (e.g. to mark a row during review)."),
    },
  },
  async ({
    budgetId,
    transactionId,
    categoryId,
    payeeName,
    memo,
    amount,
    date,
    approved,
    cleared,
    flagColor,
  }) => {
    // (1) Build the partial update from ONLY the fields the caller supplied.
    // Each `!== undefined` check means an omitted arg leaves that field
    // untouched on YNAB's side. amount is the one conversion: dollars -> the
    // integer milliunits YNAB stores.
    const transaction: ynab.ExistingTransaction = {};
    if (categoryId !== undefined) transaction.category_id = categoryId;
    if (payeeName !== undefined) transaction.payee_name = payeeName;
    if (memo !== undefined) transaction.memo = memo;
    if (amount !== undefined) transaction.amount = dollarsToMilliunits(amount);
    if (date !== undefined) transaction.date = date;
    if (approved !== undefined) transaction.approved = approved;
    if (cleared !== undefined) transaction.cleared = cleared;
    if (flagColor !== undefined) transaction.flag_color = flagColor;

    // (2) Guard: refuse a no-op so we don't make a pointless write call.
    if (Object.keys(transaction).length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "No fields to update. Supply at least one of: categoryId, " +
              "payeeName, memo, amount, date, approved, cleared, flagColor.",
          },
        ],
      };
    }

    // (3) Capture the BEFORE state for echo-back, from the delta-synced cache.
    // If the id isn't in the budget, fail early — a wrong id is a likely slip.
    const all = await getAllTransactions(budgetId, false);
    const before = all.find((t) => t.id === transactionId);
    if (!before) {
      return {
        content: [
          {
            type: "text",
            text: `No transaction with id ${transactionId} found in budget ${budgetId}.`,
          },
        ],
      };
    }

    // (4) Write. The PutTransactionWrapper is the { transaction } envelope.
    const response = await ynabAPI.transactions.updateTransaction(
      budgetId,
      transactionId,
      { transaction },
    );
    const after = response.data.transaction;

    // (5) Echo back each changed field old -> new. We use the API's response
    // as the authoritative "after" (YNAB resolves names, applies its rules).
    // Only fields the caller actually passed are listed.
    const changes: string[] = [];
    if (categoryId !== undefined)
      changes.push(
        `  category: ${before.category_name ?? "(uncategorized)"} -> ${after.category_name ?? "(uncategorized)"}`,
      );
    if (payeeName !== undefined)
      changes.push(
        `  payee: ${before.payee_name ?? "(none)"} -> ${after.payee_name ?? "(none)"}`,
      );
    if (memo !== undefined)
      changes.push(`  memo: ${before.memo ?? "(none)"} -> ${after.memo ?? "(none)"}`);
    if (amount !== undefined)
      changes.push(
        `  amount: ${formatMilliunits(before.amount)} -> ${formatMilliunits(after.amount)}`,
      );
    if (date !== undefined) changes.push(`  date: ${before.date} -> ${after.date}`);
    if (approved !== undefined)
      changes.push(`  approved: ${before.approved} -> ${after.approved}`);
    if (cleared !== undefined)
      changes.push(`  cleared: ${before.cleared} -> ${after.cleared}`);
    if (flagColor !== undefined)
      changes.push(
        `  flag: ${before.flag_color ?? "(none)"} -> ${after.flag_color ?? "(none)"}`,
      );

    const header =
      `Updated transaction ${after.id}:\n` +
      `  ${after.date} | ${after.payee_name ?? "(no payee)"} | ` +
      `${formatMilliunits(after.amount)} [${after.account_name}]`;
    const text = `${header}\n${changes.join("\n")}`;

    return { content: [{ type: "text", text }] };
  },
);

// --- 9. Register the BULK write tool "update_transactions" -----------------
// The cleanup workhorse: edit many transactions in one call. This is our first
// tool with the bulk-write safety machinery, and the headline piece of that is
// `dryRun`: it defaults to TRUE, so the tool PREVIEWS the planned change and
// writes nothing unless the caller explicitly passes dryRun:false. We start
// with just the skeleton (budgetId + dryRun); the rest is built up below.
//
// Batch cap: reject calls over this many rows. Bounds the blast radius of a
// misfired bulk write and keeps the preview readable. A single tunable constant.
const MAX_BULK_TRANSACTIONS = 100;

// The shape of one input row after Zod parsing (the single-tool fields, plus the
// transactionId that locates the row).
type BulkRow = {
  transactionId: string;
  categoryId?: string;
  payeeName?: string;
  memo?: string;
  amount?: number;
  date?: string;
  approved?: boolean;
  cleared?: "cleared" | "uncleared" | "reconciled";
  flagColor?: "red" | "orange" | "yellow" | "green" | "blue" | "purple";
};

// The SHARED before->after formatter, used by both the dry-run preview and the
// committed result so the two read identically. Lists only the fields this row
// changes. The "new" value comes from `after` (YNAB's authoritative response)
// when committing, or from the caller's intended input when previewing — and
// since a preview only has the raw categoryId, the call site resolves its name
// and passes it in as `intendedCategoryName`.
function describeRowChanges(
  before: ynab.TransactionDetail,
  row: BulkRow,
  intendedCategoryName: string | undefined,
  after?: ynab.TransactionDetail,
): string[] {
  const lines: string[] = [];
  if (row.categoryId !== undefined)
    lines.push(
      `    category: ${before.category_name ?? "(uncategorized)"} -> ${
        after
          ? (after.category_name ?? "(uncategorized)")
          : (intendedCategoryName ?? "(unknown category id)")
      }`,
    );
  if (row.payeeName !== undefined)
    lines.push(
      `    payee: ${before.payee_name ?? "(none)"} -> ${after ? (after.payee_name ?? "(none)") : row.payeeName}`,
    );
  if (row.memo !== undefined)
    lines.push(
      `    memo: ${before.memo ?? "(none)"} -> ${after ? (after.memo ?? "(none)") : row.memo}`,
    );
  if (row.amount !== undefined)
    lines.push(
      `    amount: ${formatMilliunits(before.amount)} -> ${formatMilliunits(
        after ? after.amount : dollarsToMilliunits(row.amount),
      )}`,
    );
  if (row.date !== undefined)
    lines.push(`    date: ${before.date} -> ${after ? after.date : row.date}`);
  if (row.approved !== undefined)
    lines.push(
      `    approved: ${before.approved} -> ${after ? after.approved : row.approved}`,
    );
  if (row.cleared !== undefined)
    lines.push(
      `    cleared: ${before.cleared} -> ${after ? after.cleared : row.cleared}`,
    );
  if (row.flagColor !== undefined)
    lines.push(
      `    flag: ${before.flag_color ?? "(none)"} -> ${after ? (after.flag_color ?? "(none)") : row.flagColor}`,
    );
  return lines;
}

// One transaction's one-line descriptor, used as the header above its change
// lines in the preview/echo-back.
function rowHeader(t: ynab.TransactionDetail): string {
  return (
    `${t.date} | ${t.payee_name ?? "(no payee)"} | ` +
    `${formatMilliunits(t.amount)} [${t.account_name}] (id: ${t.id})`
  );
}

// A budget's category ids -> names, flattened from the grouped getCategories
// shape. Lets the dry-run preview show a category NAME for the id the caller
// passed (e.g. "uncategorized -> Content Subscriptions") instead of a raw id.
async function getCategoryNameMap(
  budgetId: string,
): Promise<Map<string, string>> {
  const response = await ynabAPI.categories.getCategories(budgetId);
  const map = new Map<string, string>();
  for (const group of response.data.category_groups) {
    for (const c of group.categories) map.set(c.id, c.name);
  }
  return map;
}

server.registerTool(
  "update_transactions",
  {
    title: "Update multiple YNAB transactions (bulk)",
    description:
      "Edit many existing transactions in one call. MUTATES data, but dryRun " +
      "defaults to TRUE: the call previews the planned change without writing " +
      "— pass dryRun:false to commit.",
    inputSchema: {
      budgetId: z
        .string()
        .describe("The id of the budget containing the transactions."),
      // Unlike the top-level inputSchema (a raw shape — a bare object of
      // validators), each ARRAY ELEMENT is a full z.object(...). Every row
      // carries a transactionId to locate it, plus any of the same editable
      // fields the single update_transaction tool exposes (all optional —
      // send only what you're changing).
      transactions: z
        .array(
          z.object({
            transactionId: z
              .string()
              .describe("The id of the transaction to update."),
            categoryId: z
              .string()
              .optional()
              .describe("Assign this category id (from list_categories)."),
            payeeName: z
              .string()
              .optional()
              .describe("Set the payee name (resolves or creates a payee)."),
            memo: z.string().optional().describe("Set the memo/note."),
            amount: z
              .number()
              .optional()
              .describe(
                "Set the amount in DOLLARS (negative for outflow, e.g. -43.21).",
              ),
            date: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO YYYY-MM-DD")
              .optional()
              .describe("Set the date (YYYY-MM-DD). No future dates."),
            approved: z
              .boolean()
              .optional()
              .describe("Mark approved (true) or unapproved (false)."),
            cleared: z
              .enum(["cleared", "uncleared", "reconciled"])
              .optional()
              .describe("Set the cleared status."),
            flagColor: z
              .enum(["red", "orange", "yellow", "green", "blue", "purple"])
              .optional()
              .describe("Set the flag color."),
          }),
        )
        .min(1)
        .describe("The transactions to update; one entry per row."),
      dryRun: z
        .boolean()
        .default(true)
        .describe(
          "When true (the default) PREVIEW the change without writing. Pass " +
            "false to actually commit the update.",
        ),
    },
  },
  async ({ budgetId, transactions, dryRun }) => {
    // (1) Batch cap — reject oversized calls before doing any work.
    if (transactions.length > MAX_BULK_TRANSACTIONS) {
      return {
        content: [
          {
            type: "text",
            text:
              `Too many rows (${transactions.length}). The bulk cap is ` +
              `${MAX_BULK_TRANSACTIONS} per call — split into smaller batches ` +
              "and retry.",
          },
        ],
      };
    }

    // (2) Resolve current state (delta-synced cache) + category names, so we
    // can validate ids now and render a readable preview shortly.
    const all = await getAllTransactions(budgetId, false);
    const byId = new Map(all.map((t) => [t.id, t]));
    const categoryNames = await getCategoryNameMap(budgetId);

    // (3) Validate every row up front. Collect problems and abort the WHOLE
    // batch if any row is bad — never a partial write.
    const unknownIds: string[] = [];
    const noopIds: string[] = [];
    const planned: { before: ynab.TransactionDetail; row: BulkRow }[] = [];
    for (const row of transactions) {
      const before = byId.get(row.transactionId);
      if (!before) {
        unknownIds.push(row.transactionId);
        continue;
      }
      // A row that changes nothing produces zero change lines — reject it.
      const changeCount = describeRowChanges(
        before,
        row,
        categoryNames.get(row.categoryId ?? ""),
      ).length;
      if (changeCount === 0) {
        noopIds.push(row.transactionId);
        continue;
      }
      planned.push({ before, row });
    }

    if (unknownIds.length > 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "Aborted — nothing written. These transactionId(s) were not " +
              `found in budget ${budgetId}:\n` +
              unknownIds.map((id) => `  - ${id}`).join("\n") +
              "\nFix or remove them and retry.",
          },
        ],
      };
    }
    if (noopIds.length > 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "Aborted — nothing written. These row(s) have no fields to " +
              "change (only a transactionId):\n" +
              noopIds.map((id) => `  - ${id}`).join("\n") +
              "\nGive each row at least one field besides transactionId.",
          },
        ],
      };
    }

    // (4) Build the per-row preview with the SHARED formatter (no `after` arg,
    // so it renders the caller's intended values).
    const previewBlocks = planned.map(({ before, row }) => {
      const lines = describeRowChanges(
        before,
        row,
        categoryNames.get(row.categoryId ?? ""),
      );
      return `  ${rowHeader(before)}\n${lines.join("\n")}`;
    });
    const body = previewBlocks.join("\n");

    // (5) Dry run stops here: resolved and previewed, but nothing written.
    if (dryRun) {
      return {
        content: [
          {
            type: "text",
            text:
              `DRY RUN — nothing was written. ${planned.length} transaction(s) ` +
              `would be updated in budget ${budgetId}:\n${body}\n\n` +
              "Re-run with dryRun:false to commit these changes.",
          },
        ],
      };
    }

    // (6) COMMIT. Build YNAB's bulk body: an array of rows, each carrying its
    // id plus ONLY the fields it changes (same field mapping as the single
    // tool, including dollars -> milliunits). The PatchTransactionsWrapper is
    // the { transactions } envelope updateTransactions expects.
    const payload: ynab.PatchTransactionsWrapper = {
      transactions: planned.map(({ row }) => {
        const t: ynab.SaveTransactionWithIdOrImportId = {
          id: row.transactionId,
        };
        if (row.categoryId !== undefined) t.category_id = row.categoryId;
        if (row.payeeName !== undefined) t.payee_name = row.payeeName;
        if (row.memo !== undefined) t.memo = row.memo;
        if (row.amount !== undefined) t.amount = dollarsToMilliunits(row.amount);
        if (row.date !== undefined) t.date = row.date;
        if (row.approved !== undefined) t.approved = row.approved;
        if (row.cleared !== undefined) t.cleared = row.cleared;
        if (row.flagColor !== undefined) t.flag_color = row.flagColor;
        return t;
      }),
    };

    const response = await ynabAPI.transactions.updateTransactions(
      budgetId,
      payload,
    );
    // YNAB returns the updated rows; index by id to pair each with its `before`.
    const afterById = new Map(
      (response.data.transactions ?? []).map((t) => [t.id, t]),
    );

    // (7) Echo back through the SAME formatter, now passing YNAB's authoritative
    // `after` so we report what was actually stored (resolved names, its rules).
    const resultBlocks = planned.map(({ before, row }) => {
      const after = afterById.get(row.transactionId);
      const lines = describeRowChanges(
        before,
        row,
        categoryNames.get(row.categoryId ?? ""),
        after,
      );
      return `  ${rowHeader(after ?? before)}\n${lines.join("\n")}`;
    });

    return {
      content: [
        {
          type: "text",
          text:
            `Updated ${planned.length} transaction(s) in budget ${budgetId}:\n` +
            resultBlocks.join("\n"),
        },
      ],
    };
  },
);

// --- 10. Register the "create_transactions" tool ---------------------------
// Adds brand-new transactions (single or many) via createTransaction's
// { transactions } form. Central to the migration plan: it's how we'll backfill
// a fresh plan from cleaned historical data. Same safety shape as
// update_transactions (dryRun default true + batch cap), but there's no "before"
// state — rows don't exist yet — so the preview renders the rows we'd CREATE.
// We start with just the skeleton (budgetId + dryRun); the rest is built below.
// A budget's account ids -> names (non-deleted), to validate accountId and make
// the preview readable. Parallels getCategoryNameMap.
async function getAccountNameMap(
  budgetId: string,
): Promise<Map<string, string>> {
  const response = await ynabAPI.accounts.getAccounts(budgetId);
  const map = new Map<string, string>();
  for (const a of response.data.accounts) {
    if (!a.deleted) map.set(a.id, a.name);
  }
  return map;
}

// The shape of one input row after Zod parsing. Unlike the update rows, the
// three fields YNAB requires to create a transaction — accountId, date, amount —
// are mandatory; the rest are optional.
type NewRow = {
  accountId: string;
  date: string;
  amount: number;
  payeeName?: string;
  categoryId?: string;
  memo?: string;
  approved?: boolean;
  cleared?: "cleared" | "uncleared" | "reconciled";
  flagColor?: "red" | "orange" | "yellow" | "green" | "blue" | "purple";
};

// Render a row we WOULD create (preview): a one-line summary plus indented
// detail lines for any optional fields that were set.
function describeNewRow(
  row: NewRow,
  accountName: string,
  categoryName: string | undefined,
): string {
  const header =
    `  ${row.date} | ${row.payeeName ?? "(no payee)"} | ` +
    `${categoryName ?? "(uncategorized)"} | ` +
    `${formatMilliunits(dollarsToMilliunits(row.amount))} [${accountName}]`;
  const extra: string[] = [];
  if (row.memo !== undefined) extra.push(`    memo: ${row.memo}`);
  if (row.approved !== undefined) extra.push(`    approved: ${row.approved}`);
  if (row.cleared !== undefined) extra.push(`    cleared: ${row.cleared}`);
  if (row.flagColor !== undefined) extra.push(`    flag: ${row.flagColor}`);
  return extra.length > 0 ? `${header}\n${extra.join("\n")}` : header;
}

server.registerTool(
  "create_transactions",
  {
    title: "Create new YNAB transactions (single or bulk)",
    description:
      "Add one or more brand-new transactions to a budget. Each row REQUIRES " +
      "accountId, date (YYYY-MM-DD), and amount (in dollars, negative for an " +
      "outflow); payeeName, categoryId, memo, approved, cleared, and flagColor " +
      "are optional. MUTATES data, but dryRun defaults to TRUE: the call " +
      `previews the rows it would create without writing — pass dryRun:false to ` +
      `commit. Up to ${MAX_BULK_TRANSACTIONS} rows per call. Use list_accounts ` +
      "for accountId and list_categories for categoryId.",
    inputSchema: {
      budgetId: z
        .string()
        .describe("The id of the budget to add transactions to."),
      transactions: z
        .array(
          z.object({
            accountId: z
              .string()
              .describe("The account to add the transaction to (required)."),
            date: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO YYYY-MM-DD")
              .describe("The transaction date, YYYY-MM-DD (required)."),
            amount: z
              .number()
              .describe(
                "The amount in DOLLARS, negative for an outflow (required).",
              ),
            payeeName: z
              .string()
              .optional()
              .describe("Payee name (resolves or creates a payee)."),
            categoryId: z
              .string()
              .optional()
              .describe("Category id (from list_categories)."),
            memo: z.string().optional().describe("Memo/note."),
            approved: z
              .boolean()
              .optional()
              .describe("Mark approved. Defaults to unapproved if omitted."),
            cleared: z
              .enum(["cleared", "uncleared", "reconciled"])
              .optional()
              .describe("Cleared status. Defaults to uncleared if omitted."),
            flagColor: z
              .enum(["red", "orange", "yellow", "green", "blue", "purple"])
              .optional()
              .describe("Flag color."),
          }),
        )
        .min(1)
        .describe("The transactions to create; one entry per row."),
      dryRun: z
        .boolean()
        .default(true)
        .describe(
          "When true (the default) PREVIEW the rows without writing. Pass " +
            "false to actually create them.",
        ),
    },
  },
  async ({ budgetId, transactions, dryRun }) => {
    // (1) Batch cap — reject oversized calls before doing any work.
    if (transactions.length > MAX_BULK_TRANSACTIONS) {
      return {
        content: [
          {
            type: "text",
            text:
              `Too many rows (${transactions.length}). The bulk cap is ` +
              `${MAX_BULK_TRANSACTIONS} per call — split into smaller batches ` +
              "and retry.",
          },
        ],
      };
    }

    // (2) Resolve account + category names: used both to VALIDATE the ids the
    // caller passed and to render a readable preview.
    const accountNames = await getAccountNameMap(budgetId);
    const categoryNames = await getCategoryNameMap(budgetId);

    // (3) Validate ids up front; abort the WHOLE batch if any are unknown (a
    // bad account/category id is a likely slip — fail before creating anything).
    const badAccounts = new Set<string>();
    const badCategories = new Set<string>();
    for (const row of transactions) {
      if (!accountNames.has(row.accountId)) badAccounts.add(row.accountId);
      if (row.categoryId !== undefined && !categoryNames.has(row.categoryId))
        badCategories.add(row.categoryId);
    }
    if (badAccounts.size > 0 || badCategories.size > 0) {
      const problems = [
        ...[...badAccounts].map((id) => `  - unknown accountId: ${id}`),
        ...[...badCategories].map((id) => `  - unknown categoryId: ${id}`),
      ];
      return {
        content: [
          {
            type: "text",
            text:
              `Aborted — nothing created. Unknown id(s) in budget ${budgetId}:\n` +
              problems.join("\n") +
              "\nUse list_accounts / list_categories to get valid ids.",
          },
        ],
      };
    }

    // (4) Build the preview from the (now validated) rows.
    const previewBlocks = transactions.map((row) =>
      describeNewRow(
        row,
        accountNames.get(row.accountId)!,
        row.categoryId ? categoryNames.get(row.categoryId) : undefined,
      ),
    );
    const body = previewBlocks.join("\n");

    // (5) Dry run stops here: validated and previewed, but nothing written.
    if (dryRun) {
      return {
        content: [
          {
            type: "text",
            text:
              `DRY RUN — nothing was created. ${transactions.length} ` +
              `transaction(s) would be added to budget ${budgetId}:\n${body}\n\n` +
              "Re-run with dryRun:false to create them.",
          },
        ],
      };
    }

    // (6) COMMIT. Map each row to a NewTransaction (dollars -> milliunits, only
    // the fields that were set), then post the whole batch in one call.
    const payload: ynab.PostTransactionsWrapper = {
      transactions: transactions.map((row) => {
        const t: ynab.NewTransaction = {
          account_id: row.accountId,
          date: row.date,
          amount: dollarsToMilliunits(row.amount),
        };
        if (row.payeeName !== undefined) t.payee_name = row.payeeName;
        if (row.categoryId !== undefined) t.category_id = row.categoryId;
        if (row.memo !== undefined) t.memo = row.memo;
        if (row.approved !== undefined) t.approved = row.approved;
        if (row.cleared !== undefined) t.cleared = row.cleared;
        if (row.flagColor !== undefined) t.flag_color = row.flagColor;
        return t;
      }),
    };

    const response = await ynabAPI.transactions.createTransaction(
      budgetId,
      payload,
    );
    const created = response.data.transactions ?? [];

    // (7) Echo back each created row WITH its new id (YNAB's authoritative
    // resolved values).
    const resultBlocks = created.map(
      (t) =>
        `  ${t.date} | ${t.payee_name ?? "(no payee)"} | ` +
        `${t.category_name ?? "(uncategorized)"} | ` +
        `${formatMilliunits(t.amount)} [${t.account_name}] (id: ${t.id})`,
    );

    return {
      content: [
        {
          type: "text",
          text:
            `Created ${created.length} transaction(s) in budget ${budgetId}:\n` +
            resultBlocks.join("\n"),
        },
      ],
    };
  },
);

// --- 11. Connect over stdio and start serving ------------------------------
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
