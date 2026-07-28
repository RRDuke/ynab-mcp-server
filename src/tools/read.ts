// The read-only tools: list_budgets, list_accounts, list_categories,
// list_transactions. Grouped behind a single registerReadTools(server, api)
// function — the api client is INJECTED (a parameter) rather than a module
// global, the dependency-injection pattern the Phase 3 split is teaching.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as ynab from "ynab";
import { z } from "zod";
import { formatMilliunits } from "../lib/money.js";
import { ynabCall } from "../ynab/client.js";
import { getAllTransactions } from "../ynab/cache.js";

const DEFAULT_TRANSACTION_LIMIT = 50; // used when Claude omits `limit`
const MAX_TRANSACTION_LIMIT = 200; // ceiling on any single response

export function registerReadTools(server: McpServer, api: ynab.API): void {
  // --- list_budgets --------------------------------------------------------
  // (A) name + config = the Claude-facing interface. The description is how
  //     Claude decides WHEN to call this tool, so it's worth writing clearly.
  //     No inputSchema: this tool takes no arguments.
  // (B) the async callback = the YNAB logic that runs when Claude invokes it.
  //     It must return the MCP shape { content: [{ type: "text", text }] }.
  server.registerTool(
    "list_budgets",
    {
      title: "List YNAB budgets",
      // Machine-readable behavior hints (separate from the prose description so a
      // host can gate approvals structurally). readOnlyHint => no mutation;
      // openWorldHint => talks to an external system (the YNAB API).
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        "List all of the user's YNAB budgets (plans), returning each one's " +
        "name and id. Read-only.",
    },
    async () => {
      // YNAB renamed "budgets" -> "plans" in v4; the list lives at data.plans.
      const response = await ynabCall(api.plans.getPlans());
      const plans = response.data.plans;

      const lines = plans.map((p) => `- ${p.name} (id: ${p.id})`).join("\n");
      const text =
        plans.length > 0
          ? `Found ${plans.length} budget(s):\n${lines}`
          : "No budgets found for this token.";

      return { content: [{ type: "text", text }] };
    },
  );

  // --- list_accounts -------------------------------------------------------
  // First tool that takes an argument. inputSchema is a "Zod raw shape" (a plain
  // object of validators, NOT z.object({...})). The SDK validates Claude's input
  // against it before the callback runs and passes the parsed args in as the
  // first parameter — so { budgetId } below is already known to be a string.
  server.registerTool(
    "list_accounts",
    {
      title: "List accounts in a YNAB budget",
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        "List the accounts in a given YNAB budget, with each account's name, " +
        "type, current balance, and transferPayeeId. Closed accounts are " +
        "omitted. Read-only. Use list_budgets first to find the budgetId. The " +
        "transferPayeeId is the handle for moving money INTO this account; to " +
        "record a transfer (e.g. a credit-card payment), pass the TARGET " +
        "account's id as transferAccountId on a write tool.",
      inputSchema: {
        budgetId: z
          .string()
          .describe("The id of the budget to list accounts for."),
      },
    },
    async ({ budgetId }) => {
      const response = await ynabCall(api.accounts.getAccounts(budgetId));
      // Skip accounts the user has closed — they're clutter, not current data.
      const accounts = response.data.accounts.filter((a) => !a.closed);

      const lines = accounts
        .map(
          (a) =>
            `- ${a.name} [${a.type}]: ${formatMilliunits(a.balance)} ` +
            `(id: ${a.id}, transferPayeeId: ${a.transfer_payee_id})`,
        )
        .join("\n");
      const text =
        accounts.length > 0
          ? `Found ${accounts.length} open account(s):\n${lines}`
          : "No open accounts found in this budget.";

      return { content: [{ type: "text", text }] };
    },
  );

  // --- list_categories -----------------------------------------------------
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
      annotations: { readOnlyHint: true, openWorldHint: true },
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
      const response = await ynabCall(api.categories.getCategories(budgetId));
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

  // --- list_transactions ---------------------------------------------------
  // Reads from the delta-synced cache (getAllTransactions) and applies ALL
  // filtering client-side: sinceDate (date string compare), type ('unapproved'
  // is exact; 'uncategorized' is approximated as a row needing a category — not
  // categorized, not a transfer, not a split parent), and limit/offset paging.
  // The response always reports the window shown out of the matching total.
  server.registerTool(
    "list_transactions",
    {
      title: "List transactions in a YNAB budget",
      annotations: { readOnlyHint: true, openWorldHint: true },
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
      const all = await getAllTransactions(api, budgetId, refresh);

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

      // A forced refresh reports what actually came back, so a truncated
      // re-fetch is visible to the caller — not only in server stderr (Bug #1's
      // wrong answer survived because the response looked authoritative).
      if (refresh) {
        const oldest = all.reduce<string | undefined>(
          (min, t) => (min === undefined || t.date < min ? t.date : min),
          undefined,
        );
        text =
          `Refreshed from YNAB: re-fetched ${all.length} transaction(s)` +
          (oldest ? ` (oldest ${oldest})` : "") +
          `.\n${text}`;
      }

      return { content: [{ type: "text", text }] };
    },
  );
}
