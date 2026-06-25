// Shared zod schema pieces for the write tools: the SDK-sourced enums, the two
// standalone base validators, the shared optional-field set, and the two bulk
// row schemas (plus their z.infer'd row types). Pure — depends only on `ynab`
// (for the enum constants) and `zod`. Second leaf extracted in the Phase 3 split.
import * as ynab from "ynab";
import { z } from "zod";

// Source the allowed enum values from the YNAB SDK itself rather than retyping
// the string lists at each tool. `ynab.TransactionClearedStatus` and
// `TransactionFlagColor` are `as const` objects (e.g. { Cleared: "cleared" });
// zod 4's z.enum accepts such an enum-like object directly and infers the value
// union ("cleared" | "uncleared" | "reconciled"), so the schema can't drift from
// the SDK. The one wrinkle: TransactionFlagColor includes an Empty: "" member
// (YNAB's "no flag"), which we don't want callers passing — .exclude(["Empty"])
// drops it by member name, leaving the six real colors. These are immutable base
// schemas: each tool chains .optional().describe(...) onto them, which returns a
// NEW schema and never mutates the shared base, so reuse is safe.
export const clearedEnum = z.enum(ynab.TransactionClearedStatus);
export const flagColorEnum = z.enum(ynab.TransactionFlagColor).exclude(["Empty"]);

// Two standalone base validators reused by the write tools. They stay BASE
// schemas (no .optional()/.describe()) on purpose: amount and date are OPTIONAL
// when editing an existing row but REQUIRED when creating one, so each tool adds
// the optionality and wording that fit. Sharing the base keeps the "dollars"
// rule and the ISO-date regex (with one error message) in exactly one place.
export const dollarAmount = z.number();
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO format YYYY-MM-DD");

// The fields all three write tools accept as OPTIONAL edits, defined once. Each
// entry is a fully-formed validator (type + .optional() + one canonical
// description), so spreading this object into a tool's inputSchema gives every
// tool the same fields with the same Claude-facing guidance — collapsing wording
// that had drifted three different ways (the transferAccountId blurb especially).
// zod schemas are immutable and stateless during parsing, so reusing these same
// instances across all three schemas is safe. amount/date are deliberately NOT
// here — their required-ness differs (see the base validators above).
export const txnOptionalFields = {
  categoryId: z
    .string()
    .optional()
    .describe(
      "Assign this category (an id from list_categories). The category of an " +
        "existing split transaction can't be changed.",
    ),
  payeeName: z
    .string()
    .optional()
    .describe(
      "Set the payee name (resolves to an existing payee or creates one). For " +
        "a transfer, use transferAccountId instead, not payeeName.",
    ),
  transferAccountId: z
    .string()
    .optional()
    .describe(
      "Turn this row into a transfer INTO the given account (its id from " +
        "list_accounts) — e.g. a credit-card payment or a move to savings. The " +
        "tool resolves that account's transfer payee for you. A transfer should " +
        "not also carry a spending category, and can't be combined with payeeName.",
    ),
  memo: z.string().optional().describe("Set the transaction memo/note."),
  approved: z
    .boolean()
    .optional()
    .describe("Mark the transaction approved (true) or unapproved (false)."),
  cleared: clearedEnum
    .optional()
    .describe(
      "Set the cleared status. Mark 'cleared' once a transaction has been " +
        "vetted and needs no further review.",
    ),
  flagColor: flagColorEnum
    .optional()
    .describe("Set the flag color (e.g. to mark a row during review)."),
};

// The two bulk-tool ARRAY ELEMENT schemas, named so their row TYPE can be derived
// from them with z.infer (below) instead of hand-maintained. Unlike the single
// update_transaction (whose inputSchema is a raw shape — a bare object), each
// bulk element is a full z.object(...). A bulk-update row locates the target by
// transactionId then carries any optional edit; a create row makes
// accountId/date/amount REQUIRED and shares the same optional tail.
export const bulkRowSchema = z.object({
  transactionId: z.string().describe("The id of the transaction to update."),
  ...txnOptionalFields,
  amount: dollarAmount
    .optional()
    .describe("Set the amount in DOLLARS (negative for outflow, e.g. -43.21)."),
  date: isoDate
    .optional()
    .describe("Set the date (YYYY-MM-DD). No future dates — YNAB rejects them."),
});

export const newRowSchema = z.object({
  accountId: z
    .string()
    .describe("The account to add the transaction to (required)."),
  date: isoDate.describe(
    "The transaction date, YYYY-MM-DD (required). No future dates — YNAB " +
      "rejects them.",
  ),
  amount: dollarAmount.describe(
    "The amount in DOLLARS, negative for an outflow (required).",
  ),
  ...txnOptionalFields,
});

// Row shapes DERIVED from the schemas with z.infer — so the static type follows
// the validators automatically and the two can't drift. (z.infer gives the
// OUTPUT type, post-parse; z.input would be the pre-parse type. They coincide
// here because the only .default() — dryRun — lives in the top-level tool shape,
// not the rows.)
export type BulkRow = z.infer<typeof bulkRowSchema>;
export type NewRow = z.infer<typeof newRowSchema>;
