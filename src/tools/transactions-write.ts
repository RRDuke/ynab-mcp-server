// The transaction WRITE tools: update_transaction (single), update_transactions
// (bulk), create_transactions (single+bulk), delete_transaction. Grouped behind
// registerTransactionWriteTools(server, api) with the api client INJECTED. The
// four share real machinery (the dryRun preview/commit dance, the transfer
// resolution, the before->after formatters), so they live together; this file is
// large because that machinery is genuinely shared, not by accident.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as ynab from "ynab";
import { z } from "zod";
import { formatMilliunits, dollarsToMilliunits } from "../lib/money.js";
import {
  dollarAmount,
  isoDate,
  txnOptionalFields,
  bulkRowSchema,
  newRowSchema,
  type BulkRow,
  type NewRow,
} from "../lib/schemas.js";
import { ynabCall } from "../ynab/client.js";
import { getAllTransactions } from "../ynab/cache.js";
import { getAccountMaps, getCategoryNameMap } from "../ynab/lookups.js";

// A refused/aborted write is a FAILURE the client should be able to detect, not
// prose to parse. The MCP SDK only sets isError on a throw, so our hand-built
// guard `return`s need to set it themselves. `type: "text" as const` keeps the
// literal type the SDK's content union requires (a bare "text" widens to string
// and won't match). Used by every guard/abort below; dryRun previews and real
// successes deliberately do NOT use it — they succeeded.
function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// Batch cap: reject calls over this many rows. Bounds the blast radius of a
// misfired bulk write and keeps the preview readable. A single tunable constant.
const MAX_BULK_TRANSACTIONS = 100;

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
  intendedTransferAccountName: string | undefined,
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
  if (row.transferAccountId !== undefined)
    lines.push(
      `    transfer: ${before.payee_name ?? "(none)"} -> ${
        after
          ? (after.payee_name ?? "(none)")
          : `Transfer : ${intendedTransferAccountName ?? "(unknown account id)"}`
      }`,
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

// Render a row we WOULD create (preview): a one-line summary plus indented
// detail lines for any optional fields that were set. For a transfer the payee
// shows as "Transfer : <target account>" (transferAccountName), mirroring how
// YNAB labels it.
function describeNewRow(
  row: NewRow,
  accountName: string,
  categoryName: string | undefined,
  transferAccountName: string | undefined,
): string {
  const payeeLabel = row.transferAccountId
    ? `Transfer : ${transferAccountName ?? "(unknown account id)"}`
    : (row.payeeName ?? "(no payee)");
  const header =
    `  ${row.date} | ${payeeLabel} | ` +
    `${categoryName ?? "(uncategorized)"} | ` +
    `${formatMilliunits(dollarsToMilliunits(row.amount))} [${accountName}]`;
  const extra: string[] = [];
  if (row.memo !== undefined) extra.push(`    memo: ${row.memo}`);
  if (row.approved !== undefined) extra.push(`    approved: ${row.approved}`);
  if (row.cleared !== undefined) extra.push(`    cleared: ${row.cleared}`);
  if (row.flagColor !== undefined) extra.push(`    flag: ${row.flagColor}`);
  return extra.length > 0 ? `${header}\n${extra.join("\n")}` : header;
}

export function registerTransactionWriteTools(
  server: McpServer,
  api: ynab.API,
): void {
  // --- update_transaction --------------------------------------------------
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
      // A write: not read-only, may overwrite existing field values
      // (destructive), and re-running can land different results if the row
      // changed meanwhile (not idempotent).
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
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
        ...txnOptionalFields,
        amount: dollarAmount
          .optional()
          .describe(
            "Set the amount in DOLLARS (negative for outflow, e.g. -43.21). " +
              "Converted to YNAB milliunits internally.",
          ),
        date: isoDate
          .optional()
          .describe("Set the transaction date (YYYY-MM-DD)."),
      },
    },
    async ({
      budgetId,
      transactionId,
      categoryId,
      payeeName,
      transferAccountId,
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
      // integer milliunits YNAB stores. payee_id (the transfer) is resolved in
      // step (3) once we have the row's own account to guard against.
      const transaction: ynab.ExistingTransaction = {};
      if (categoryId !== undefined) transaction.category_id = categoryId;
      if (payeeName !== undefined) transaction.payee_name = payeeName;
      if (memo !== undefined) transaction.memo = memo;
      if (amount !== undefined) transaction.amount = dollarsToMilliunits(amount);
      if (date !== undefined) transaction.date = date;
      if (approved !== undefined) transaction.approved = approved;
      if (cleared !== undefined) transaction.cleared = cleared;
      if (flagColor !== undefined) transaction.flag_color = flagColor;

      // (2) Guard: payeeName and transferAccountId both set the payee — they
      // conflict. Make the caller pick one rather than silently dropping one.
      if (payeeName !== undefined && transferAccountId !== undefined) {
        return fail(
          "Pass either payeeName OR transferAccountId, not both — they " +
            "both set the payee. Use transferAccountId for a transfer.",
        );
      }

      // (3) Capture the BEFORE state for echo-back, from the delta-synced cache.
      // If the id isn't in the budget, fail early — a wrong id is a likely slip.
      const all = await getAllTransactions(api, budgetId, false);
      const before = all.find((t) => t.id === transactionId);
      if (!before) {
        return fail(
          `No transaction with id ${transactionId} found in budget ${budgetId}.`,
        );
      }

      // Resolve a transfer: turn transferAccountId into the target account's
      // transfer_payee_id (the payee_id YNAB wants). Reject an unknown account or
      // a transfer into the row's OWN account (which YNAB can't represent).
      if (transferAccountId !== undefined) {
        if (transferAccountId === before.account_id) {
          return fail(
            "Cannot transfer a transaction into its own account " +
              `(${before.account_name}). transferAccountId must be a different account.`,
          );
        }
        const { transferPayees } = await getAccountMaps(api, budgetId);
        const payeeId = transferPayees.get(transferAccountId);
        if (payeeId === undefined) {
          return fail(
            `No account with id ${transferAccountId} found in budget ` +
              `${budgetId}. Use list_accounts to get a valid transferAccountId.`,
          );
        }
        transaction.payee_id = payeeId;
      }

      // (4) Guard: refuse a no-op so we don't make a pointless write call.
      if (Object.keys(transaction).length === 0) {
        return fail(
          "No fields to update. Supply at least one of: categoryId, " +
            "payeeName, transferAccountId, memo, amount, date, approved, " +
            "cleared, flagColor.",
        );
      }

      // (5) Write. The PutTransactionWrapper is the { transaction } envelope.
      const response = await ynabCall(
        api.transactions.updateTransaction(budgetId, transactionId, {
          transaction,
        }),
      );
      const after = response.data.transaction;

      // (6) Echo back each changed field old -> new. We use the API's response
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
      if (transferAccountId !== undefined)
        changes.push(
          `  transfer: ${before.payee_name ?? "(none)"} -> ${after.payee_name ?? "(none)"}`,
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

  // --- update_transactions (BULK) ------------------------------------------
  // The cleanup workhorse: edit many transactions in one call. The headline
  // safety piece is `dryRun`: it defaults to TRUE, so the tool PREVIEWS the
  // planned change and writes nothing unless the caller explicitly passes
  // dryRun:false.
  server.registerTool(
    "update_transactions",
    {
      title: "Update multiple YNAB transactions (bulk)",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      description:
        "Edit many existing transactions in one call. MUTATES data, but dryRun " +
        "defaults to TRUE: the call previews the planned change without writing " +
        "— pass dryRun:false to commit.",
      inputSchema: {
        budgetId: z
          .string()
          .describe("The id of the budget containing the transactions."),
        transactions: z
          .array(bulkRowSchema)
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
        return fail(
          `Too many rows (${transactions.length}). The bulk cap is ` +
            `${MAX_BULK_TRANSACTIONS} per call — split into smaller batches ` +
            "and retry.",
        );
      }

      // (2) Resolve current state (delta-synced cache) + category names + account
      // maps (names for readable previews, transfer payees to resolve transfers),
      // so we can validate ids now and render a readable preview shortly.
      const all = await getAllTransactions(api, budgetId, false);
      const byId = new Map(all.map((t) => [t.id, t]));
      const categoryNames = await getCategoryNameMap(api, budgetId);
      const { names: accountNames, transferPayees } = await getAccountMaps(
        api,
        budgetId,
      );

      // (3) Validate every row up front. Collect problems and abort the WHOLE
      // batch if any row is bad — never a partial write. Each planned row also
      // carries its resolved transferPayeeId (when it's a transfer) for commit.
      const unknownIds: string[] = [];
      const noopIds: string[] = [];
      const conflictIds: string[] = []; // payeeName AND transferAccountId both set
      const selfTransferIds: string[] = []; // transfer into the row's own account
      const badTransferAccounts: string[] = []; // transferAccountId not an account
      const planned: {
        before: ynab.TransactionDetail;
        row: BulkRow;
        transferPayeeId?: string;
      }[] = [];
      for (const row of transactions) {
        const before = byId.get(row.transactionId);
        if (!before) {
          unknownIds.push(row.transactionId);
          continue;
        }
        // Resolve/validate a transfer (mirrors the single update_transaction):
        // payeeName conflict, self-transfer, and unknown account each abort.
        let transferPayeeId: string | undefined;
        if (row.transferAccountId !== undefined) {
          if (row.payeeName !== undefined) {
            conflictIds.push(row.transactionId);
            continue;
          }
          if (row.transferAccountId === before.account_id) {
            selfTransferIds.push(row.transactionId);
            continue;
          }
          transferPayeeId = transferPayees.get(row.transferAccountId);
          if (transferPayeeId === undefined) {
            badTransferAccounts.push(row.transferAccountId);
            continue;
          }
        }
        // A row that changes nothing produces zero change lines — reject it.
        const changeCount = describeRowChanges(
          before,
          row,
          categoryNames.get(row.categoryId ?? ""),
          row.transferAccountId
            ? accountNames.get(row.transferAccountId)
            : undefined,
        ).length;
        if (changeCount === 0) {
          noopIds.push(row.transactionId);
          continue;
        }
        planned.push({ before, row, transferPayeeId });
      }

      if (unknownIds.length > 0) {
        return fail(
          "Aborted — nothing written. These transactionId(s) were not " +
            `found in budget ${budgetId}:\n` +
            unknownIds.map((id) => `  - ${id}`).join("\n") +
            "\nFix or remove them and retry.",
        );
      }
      if (noopIds.length > 0) {
        return fail(
          "Aborted — nothing written. These row(s) have no fields to " +
            "change (only a transactionId):\n" +
            noopIds.map((id) => `  - ${id}`).join("\n") +
            "\nGive each row at least one field besides transactionId.",
        );
      }
      if (conflictIds.length > 0) {
        return fail(
          "Aborted — nothing written. These row(s) set BOTH payeeName and " +
            "transferAccountId (they conflict — pick one):\n" +
            conflictIds.map((id) => `  - ${id}`).join("\n") +
            "\nUse transferAccountId for a transfer; drop payeeName.",
        );
      }
      if (selfTransferIds.length > 0) {
        return fail(
          "Aborted — nothing written. These row(s) transfer into their OWN " +
            "account, which YNAB can't represent:\n" +
            selfTransferIds.map((id) => `  - ${id}`).join("\n") +
            "\nUse a different transferAccountId.",
        );
      }
      if (badTransferAccounts.length > 0) {
        return fail(
          `Aborted — nothing written. Unknown transferAccountId(s) in budget ` +
            `${budgetId}:\n` +
            badTransferAccounts.map((id) => `  - ${id}`).join("\n") +
            "\nUse list_accounts to get valid account ids.",
        );
      }

      // (4) Build the per-row preview with the SHARED formatter (no `after` arg,
      // so it renders the caller's intended values).
      const previewBlocks = planned.map(({ before, row }) => {
        const lines = describeRowChanges(
          before,
          row,
          categoryNames.get(row.categoryId ?? ""),
          row.transferAccountId
            ? accountNames.get(row.transferAccountId)
            : undefined,
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
        transactions: planned.map(({ row, transferPayeeId }) => {
          const t: ynab.SaveTransactionWithIdOrImportId = {
            id: row.transactionId,
          };
          if (row.categoryId !== undefined) t.category_id = row.categoryId;
          if (row.payeeName !== undefined) t.payee_name = row.payeeName;
          if (transferPayeeId !== undefined) t.payee_id = transferPayeeId;
          if (row.memo !== undefined) t.memo = row.memo;
          if (row.amount !== undefined) t.amount = dollarsToMilliunits(row.amount);
          if (row.date !== undefined) t.date = row.date;
          if (row.approved !== undefined) t.approved = row.approved;
          if (row.cleared !== undefined) t.cleared = row.cleared;
          if (row.flagColor !== undefined) t.flag_color = row.flagColor;
          return t;
        }),
      };

      const response = await ynabCall(
        api.transactions.updateTransactions(budgetId, payload),
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
          row.transferAccountId
            ? accountNames.get(row.transferAccountId)
            : undefined,
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

  // --- create_transactions -------------------------------------------------
  // Adds brand-new transactions (single or many) via createTransaction's
  // { transactions } form. Central to the migration plan: it's how we'll backfill
  // a fresh plan from cleaned historical data. Same safety shape as
  // update_transactions (dryRun default true + batch cap), but there's no "before"
  // state — rows don't exist yet — so the preview renders the rows we'd CREATE.
  server.registerTool(
    "create_transactions",
    {
      title: "Create new YNAB transactions (single or bulk)",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      description:
        "Add one or more brand-new transactions to a budget. Each row REQUIRES " +
        "accountId, date (YYYY-MM-DD), and amount (in dollars, negative for an " +
        "outflow); payeeName, categoryId, memo, approved, cleared, and flagColor " +
        "are optional. MUTATES data, but dryRun defaults to TRUE: the call " +
        `previews the rows it would create without writing — pass dryRun:false to ` +
        `commit. Up to ${MAX_BULK_TRANSACTIONS} rows per call. NOT idempotent: ` +
        "YNAB does no content dedup, so committing the same rows twice creates " +
        "duplicates. Use list_accounts for accountId and list_categories for " +
        "categoryId.",
      inputSchema: {
        budgetId: z
          .string()
          .describe("The id of the budget to add transactions to."),
        transactions: z
          .array(newRowSchema)
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
        return fail(
          `Too many rows (${transactions.length}). The bulk cap is ` +
            `${MAX_BULK_TRANSACTIONS} per call — split into smaller batches ` +
            "and retry.",
        );
      }

      // (2) Resolve account + category names + transfer payees: used both to
      // VALIDATE the ids the caller passed and to render a readable preview.
      const { names: accountNames, transferPayees } = await getAccountMaps(
        api,
        budgetId,
      );
      const categoryNames = await getCategoryNameMap(api, budgetId);

      // (3) Validate ids up front; abort the WHOLE batch if anything's off (a bad
      // id or a malformed transfer is a likely slip — fail before creating
      // anything). Rows are referenced by 1-based position since they have no id
      // yet.
      const badAccounts = new Set<string>();
      const badCategories = new Set<string>();
      const badTransferAccounts = new Set<string>();
      const conflictRows: string[] = []; // payeeName AND transferAccountId
      const selfTransferRows: string[] = []; // transferAccountId === own accountId
      transactions.forEach((row, i) => {
        if (!accountNames.has(row.accountId)) badAccounts.add(row.accountId);
        if (row.categoryId !== undefined && !categoryNames.has(row.categoryId))
          badCategories.add(row.categoryId);
        if (row.transferAccountId !== undefined) {
          if (row.payeeName !== undefined) conflictRows.push(`row ${i + 1}`);
          if (row.transferAccountId === row.accountId)
            selfTransferRows.push(`row ${i + 1}`);
          if (!transferPayees.has(row.transferAccountId))
            badTransferAccounts.add(row.transferAccountId);
        }
      });
      if (
        badAccounts.size > 0 ||
        badCategories.size > 0 ||
        badTransferAccounts.size > 0 ||
        conflictRows.length > 0 ||
        selfTransferRows.length > 0
      ) {
        const problems = [
          ...[...badAccounts].map((id) => `  - unknown accountId: ${id}`),
          ...[...badCategories].map((id) => `  - unknown categoryId: ${id}`),
          ...[...badTransferAccounts].map(
            (id) => `  - unknown transferAccountId: ${id}`,
          ),
          ...conflictRows.map(
            (r) => `  - ${r}: set both payeeName and transferAccountId (pick one)`,
          ),
          ...selfTransferRows.map(
            (r) => `  - ${r}: transfers into its own account`,
          ),
        ];
        return fail(
          `Aborted — nothing created. Problem(s) in budget ${budgetId}:\n` +
            problems.join("\n") +
            "\nUse list_accounts / list_categories to get valid ids.",
        );
      }

      // (4) Build the preview from the (now validated) rows.
      const previewBlocks = transactions.map((row) =>
        describeNewRow(
          row,
          accountNames.get(row.accountId)!,
          row.categoryId ? categoryNames.get(row.categoryId) : undefined,
          row.transferAccountId
            ? accountNames.get(row.transferAccountId)
            : undefined,
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
          if (row.transferAccountId !== undefined)
            t.payee_id = transferPayees.get(row.transferAccountId);
          if (row.categoryId !== undefined) t.category_id = row.categoryId;
          if (row.memo !== undefined) t.memo = row.memo;
          if (row.approved !== undefined) t.approved = row.approved;
          if (row.cleared !== undefined) t.cleared = row.cleared;
          if (row.flagColor !== undefined) t.flag_color = row.flagColor;
          return t;
        }),
      };

      const response = await ynabCall(
        api.transactions.createTransaction(budgetId, payload),
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

  // --- delete_transaction --------------------------------------------------
  // Removes one transaction — for clearing out duplicates and junk rows (and for
  // undoing a create_transactions test row). Single-row, like update_transaction:
  // it relies on the MCP client's per-call approval rather than dryRun. We capture
  // the row's details from the cache BEFORE deleting so the echo-back can report
  // exactly what was removed, and fail cleanly if the id isn't in the budget.
  // deleteTransaction returns the deleted row in data.transaction (deleted: true).
  server.registerTool(
    "delete_transaction",
    {
      title: "Delete a single YNAB transaction",
      // Destructive (removes a row), but idempotent: deleting an already-deleted
      // id converges to the same state (our guard reports it as not-found).
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        "Permanently delete one transaction from a YNAB budget — typically to " +
        "remove a duplicate or junk row. Provide budgetId and transactionId. " +
        "MUTATES data (deletes). Use list_transactions to find the transactionId.",
      inputSchema: {
        budgetId: z
          .string()
          .describe("The id of the budget containing the transaction."),
        transactionId: z
          .string()
          .describe("The id of the transaction to delete."),
      },
    },
    async ({ budgetId, transactionId }) => {
      // Capture the BEFORE state for the echo-back. If the id isn't in the budget,
      // fail early — a wrong id is a likely slip, and there's nothing to delete.
      const all = await getAllTransactions(api, budgetId, false);
      const before = all.find((t) => t.id === transactionId);
      if (!before) {
        return fail(
          `No transaction with id ${transactionId} found in budget ${budgetId}.`,
        );
      }

      await ynabCall(
        api.transactions.deleteTransaction(budgetId, transactionId),
      );

      return {
        content: [
          {
            type: "text",
            text:
              `Deleted transaction ${before.id}:\n` +
              `  ${before.date} | ${before.payee_name ?? "(no payee)"} | ` +
              `${before.category_name ?? "(uncategorized)"} | ` +
              `${formatMilliunits(before.amount)} [${before.account_name}]`,
          },
        ],
      };
    },
  );
}
