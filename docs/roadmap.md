# YNAB MCP server — roadmap

A learning project built incrementally, one chunk at a time. Each tool is
registered on the MCP server in `src/server.ts` and verified via
`scripts/smoke-test.ts`. See `docs/ynab-api.md` for the full SDK endpoint map.

## Done

### Milestone 1 — scaffold
Node/TypeScript ESM project, deps, tsconfig, `.env` handling, `.gitignore`.

### Milestone 2 — first read tool
`list_budgets` (no-arg tool) + dev/build/start scripts + `.mcp.json`
registration for Claude Code.

### Milestone 3 — read tools that take arguments
Verified end-to-end against a real budget.
- `list_accounts` — first inputSchema (Zod) + `formatMilliunits` helper.
- `list_categories` — nested data (category_groups -> categories).
- `list_transactions` — optional `sinceDate` arg, newest-first, output capped.

Open items carried forward:
- `list_transactions` `type` filter (folded into M4 read enhancements below).
- "Internal Master Category" group shows through in `list_categories` (not
  flagged hidden by the API). Decide whether to filter it by name.

## Planned

The overall goal driving M4/M5: have Claude help **review, clean, and
categorize spending since the start of 2025**, then **reconfigure the budget**
based on what that analysis reveals.

### Milestone 4 — Phase 1: review, clean & categorize
The cleanup workflow over existing transaction data.

**Read enhancements (do first — current tools can't support the workflow):**
- `list_transactions`: add optional `type` filter — the enum
  `"uncategorized" | "unapproved"` passed as `getTransactions`' 3rd arg. Lets
  Claude pull just the rows that need attention.
- `list_transactions`: client-side pagination. NOTE: YNAB has no server-side
  offset/limit paging — `getTransactions` returns the entire matching set in
  one call (only `sinceDate` + a delta cursor exist). So we add `limit` and
  `offset` inputs, slice the fetched array ourselves, and report the total
  count and the window shown. Replaces the current fixed 50-row cap.

**Write tools:**
- `update_transaction` — `updateTransaction`; categorize/fix one row.
- `update_transactions` (bulk) — `updateTransactions` with
  `{ transactions: [{ id, category_id, ... }] }`. The cleanup workhorse:
  categorize many rows in one call. Every field but `id` is optional.
- `create_transaction` — `createTransaction`. Supports BOTH single and bulk:
  the `PostTransactionsWrapper` takes `transaction` OR `transactions[]`, so one
  tool can add a row or import a batch (e.g. missing history from a statement).
- `delete_transaction` — `deleteTransaction`; remove dupes/junk.

**New concepts introduced here:**
- Nested request-body wrappers: inputSchema grows from flat fields to nested
  `z.object(...)` shapes.
- Dollars -> milliunits, the reverse of `formatMilliunits` (Claude thinks in
  dollars; YNAB stores integer milliunits).
- Bulk arrays of objects as input.
- Side effects on real financial data (see Safety below).

### Milestone 5 — Phase 2: configure the budget
Reshape the budget structure based on the M4 analysis.

- `create_category_group` — `createCategoryGroup`; new top-level groupings.
- `create_category` — `createCategory`; new categories within a group.
- `update_category` — `updateCategory`. Body includes `category_group_id`, so
  this also MOVES a category between groups, not just rename/hide.
- `update_category_group` — `updateCategoryGroup`; rename a group.
- `assign_to_category` — `updateMonthCategory`; budget money to a category for
  a given month (the core YNAB action).

## Cross-cutting: safety posture (decide before writing M4)
Bulk writes on real money are the sharp edge — a misfired `update_transactions`
could mis-categorize hundreds of rows. To settle before Phase 1 code:
- Dry-run / preview mode for bulk operations?
- Echo back what was written (ids + before/after) in the tool result?
- An approval threshold for writes touching more than N rows?
- How loud the tool descriptions are about being destructive.

## Scope decisions (locked 2026-06-06)
- M4 and M5 are split (not one big milestone).
- Read volume handled via full client-side pagination (limit/offset), not just
  a higher cap.
- Bulk create IS in scope (createTransaction handles single + array).
