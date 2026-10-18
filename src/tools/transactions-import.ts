// import_transactions: the API equivalent of the app's "Import" button. Lives in
// its own module because it shares none of transactions-write.ts's machinery
// (no dryRun dance, no before->after diff) — it's one call with no inputs to
// preview. Same DI shape as every other register*() function.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as ynab from "ynab";
import { z } from "zod";
import { formatMilliunits } from "../lib/money.js";
import { ynabCall } from "../ynab/client.js";
import { getAllTransactions } from "../ynab/cache.js";

export function registerImportTools(server: McpServer, api: ynab.API): void {
  // --- import_transactions -------------------------------------------------
  // POST /plans/{id}/transactions/import. Per the SDK docs this is exactly
  // "clicking Import on each account in the web application": YNAB asks every
  // linked (direct-import) account's bank for new transactions and adds them.
  // The response carries only the new ids, so we pull them through the cache
  // (a cheap delta, since the import bumped server_knowledge) to echo back
  // date/payee/amount/account instead of bare ids.
  //
  // No dryRun: there's nothing to preview — what the bank has waiting is only
  // known by importing it. The effect is additive and matches the button, and
  // YNAB dedupes against import_id, so a repeat call just imports nothing.
  server.registerTool(
    "import_transactions",
    {
      title: "Import new transactions from linked accounts",
      // Adds rows (not destructive, and nothing existing is changed). Not
      // marked idempotent: a later call can legitimately pull rows the bank
      // published in between.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      description:
        "Ask YNAB to import pending transactions from every linked " +
        "(direct-import) account in a budget — the same as pressing the " +
        "app's \"Import\" button on each account. Provide budgetId. Returns " +
        "the transactions that were imported (they arrive unapproved, ready " +
        "for review). It can only return what YNAB's bank-data provider has " +
        "already received, so a charge the bank hasn't sent yet won't appear. " +
        "Accounts that aren't bank-linked are unaffected. " +
        "MUTATES data (adds transactions); no dryRun, since there is nothing " +
        "to preview.",
      inputSchema: {
        budgetId: z.string().describe("The id of the budget to import into."),
      },
    },
    async ({ budgetId }) => {
      const response = await ynabCall(
        api.transactions.importTransactions(budgetId),
      );
      const ids = response.data.transaction_ids;

      if (ids.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                `Import ran for budget ${budgetId}: no new transactions were ` +
                `waiting on the linked accounts.`,
            },
          ],
        };
      }

      // Resolve the ids to readable rows. Diagnostics shouldn't turn a
      // successful import into a reported failure, so a lookup error falls
      // back to listing the ids.
      let lines: string[];
      try {
        const all = await getAllTransactions(api, budgetId, false);
        const byId = new Map(all.map((t) => [t.id, t]));
        lines = ids.map((id) => {
          const t = byId.get(id);
          return t
            ? `  ${t.date} | ${t.payee_name ?? "(no payee)"} | ` +
                `${formatMilliunits(t.amount)} [${t.account_name}] (id: ${t.id})`
            : `  (id: ${id}) — not found in the refreshed cache`;
        });
      } catch (e) {
        console.error(
          `[import] row lookup failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        lines = ids.map((id) => `  (id: ${id})`);
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Imported ${ids.length} transaction(s) into budget ${budgetId}:\n` +
              lines.join("\n"),
          },
        ],
      };
    },
  );
}
