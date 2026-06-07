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

**Read enhancements (DONE — commits 0b7e809, d73373b):**
- `list_transactions` `type` filter — `"uncategorized" | "unapproved"`. Now
  applied client-side (see cache below): `unapproved` is exact; `uncategorized`
  is approximated as a row needing a category (no category_id, not a transfer,
  not a split parent).
- `list_transactions` `limit`/`offset` pagination via Zod `.default()`, slicing
  client-side and reporting the window shown out of the matching total.
- Delta-synced transaction cache (`getAllTransactions`): per-budget cache kept
  fresh via YNAB's `server_knowledge` cursor. First call fetches the full set;
  later calls fetch only changes and merge by id. All filters/paging run over
  this complete local set.

IMPLICATION FOR WRITES: because every read does a cheap delta sync, the cache
self-heals after our own writes — the next read merges the changes back. So we
likely do NOT need explicit cache invalidation on write; a write can simply let
the next read pick up the delta (optionally force `refresh` for read-your-write
certainty). Confirm this holds once the first write tool exists.

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

## Cross-cutting: safety posture (decided 2026-06-06)
Bulk writes on real money are the sharp edge — a misfired `update_transactions`
could mis-categorize hundreds of rows. The MCP client already prompts the user
to approve every tool call; these add protection on top of that:

- **dryRun defaults to TRUE on every bulk write.** The tool resolves names->ids
  and dollars->milliunits and returns the full planned change WITHOUT writing.
  Claude must explicitly pass `dryRun: false` to commit. A mistaken call
  previews instead of mutating.
- **Per-row before -> after echo-back.** Both the dry-run preview and the
  committed result list each affected id with old value -> new value, so every
  change is auditable in the conversation. Preview and commit share one format.
- **Batch cap with a clear error.** Bulk calls over a limit (start at 100 rows)
  are rejected with a message telling Claude to split the batch. Bounds blast
  radius and keeps previews readable. Limit is a single tunable constant.
- Tool descriptions state plainly that the tool mutates data.

Single-row writes (`update_transaction`, `delete_transaction`) rely on the
client's per-call approval + echo-back; the dryRun/cap machinery is for the
bulk tools where blast radius is large.

## Scope decisions (locked 2026-06-06)
- M4 and M5 are split (not one big milestone).
- Read volume handled via full client-side pagination (limit/offset), not just
  a higher cap.
- Bulk create IS in scope (createTransaction handles single + array).
