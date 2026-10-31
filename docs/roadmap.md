# YNAB MCP server — roadmap

A learning project built incrementally, one chunk at a time. Each tool is
registered on the MCP server in `src/server.ts` and verified via
`scripts/smoke-test.ts`. See `docs/ynab-api.md` for the full SDK endpoint map.

## North-star program: clean up, then migrate to a fresh plan (2026-06-12)

The tools exist to serve a larger data-cleanup-and-migration program. Context:

- The long-running budget (the "old budget" below) has been **connected to bank data for
  several years but left largely unattended.** As a result the transaction data
  has **both duplicates and gaps** (missing sources): some bank connections have
  failed over time, others are still active.
- That messy data is still **valuable on two counts**: (1) we can use it to
  **backfill a fresh plan** with the very tools we're building, and (2) it should
  contain a **representative sample of real spending** to inform a better budget
  schema.

The program, in order:

1. **Categorize the available data** — work the cleanup queue in the existing
   plan (this is what Milestone 4's write tools are for; the NYT batch was the
   first run).
2. **Evaluate Amazon disambiguation** — assess whether we can resolve vague
   "Amazon" charges into real categories by **combining them with manual Amazon
   order-history downloads** (matching by date/amount). Feasibility study, not a
   commitment yet.
3. **Adjust the budget schema** — reshape categories/groups based on what the
   cleaned data and the spending sample reveal (Milestone 5's category tools).
4. **Create a fresh plan** — stand up a new YNAB plan and **ensure all current
   accounts are connected.** NOTE/OPEN: the YNAB API has no "create budget"
   endpoint and bank linking happens in-app, so this step is likely **manual in
   the YNAB app**, not tool-driven — confirm at code-time.
5. **Download as much historical data as possible** — pull whatever the freshly
   connected banks will give (fresh connections typically backfill only a short
   window, which is exactly why the old plan's history matters).
6. **Integrate confirmed-good data from the old budget** — backfill the
   fresh plan with the de-duped, validated historical transactions from the old
   plan, using `create_transaction` (bulk). The old plan is the long-tail
   history the new bank connections can't reproduce.
7. **Categorize all transactions** in the fresh, consolidated plan.

How this maps to the milestones below: **M4** delivers the write/cleanup tools
(steps 1, and the create/delete tools that make 6 possible); **M5** delivers the
schema-editing tools (step 3). Steps 4–7 are the migration run that uses them.

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

### Bug #1 fix — silent ~12-month cache truncation (2026-07-28)
Found in production use: `GET /transactions` with no `since_date` returns only a
trailing ~12-month window, NOT the whole budget — the cache's full fetch assumed
otherwise, so every tool (reads AND writes, which look up rows in the same
cache) silently saw 2,558 of 20,855 transactions. Fixed: full fetches pass an
explicit `since_date` floor (delta calls still rely on `serverKnowledge` alone);
a truncation guard cross-checks the cache's oldest row against the plan's
`first_month` and alarms on stderr; `refresh: true` now reports what it
re-fetched; smoke test gained ground-truth tripwires (total >= 15,000, oldest
pre-2017). Also added `scripts/export-transactions.ts` (full-history JSON/CSV
export). Lesson (same class as the session-#8 one): verify what an omitted API
parameter does — the wrong assumption lived in a confident comment.

### `import_transactions` — the app's "Import" button (2026-10-18)
`POST /plans/{id}/transactions/import` via the SDK's
`transactions.importTransactions(planId)`: asks every linked (direct-import)
account in the budget to pull pending transactions from its bank. Returns only
the new ids, so the tool resolves them through the cache (cheap delta) to echo
date/payee/amount/account. No dryRun — there's nothing to preview, the effect is
additive, and YNAB dedupes on `import_id`. Lives in
`src/tools/transactions-import.ts`. Verified live on the live budget (0 waiting
→ clean "nothing new" message) and on a bogus id (`isError`, readable YNAB
error). The smoke test makes a real call on the live budget (by name, never
the archived budget) and checks the reply shape; 0 imported passes. Not yet
exercised: the row-echo path with a non-empty import.

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
do NOT need explicit cache invalidation on write; a write can simply let the
next read pick up the delta (optionally force `refresh` for read-your-write
certainty). CONFIRMED 2026-06-07: after `update_transaction` wrote one row, the
next `list_transactions` logged "delta merged 1 change" — the cache picked up
our own write with no invalidation.

**`cleared` vs `approved` — two independent flags, don't conflate them:**
- **`cleared`** (`cleared` | `uncleared` | `reconciled`) is a *bank* fact: has
  this transaction cleared the financial institution? Bank-linked imports
  arrive **already `cleared`**, so on this budget `cleared` is NOT a
  "needs-review" signal — almost everything is already cleared.
- **`approved`** is a *user* fact: has a human reviewed/vetted this row? Bank
  imports arrive **`approved = false`** and stay there until the user approves.
- So the real "needs cleanup" signal here is **`approved = false`** (often paired
  with uncategorized), NOT uncleared. The cleanup workhorse action is therefore
  **set `category_id` + set `approved = true`** in one write. `list_transactions`'
  `type: "unapproved"` filter is the way to surface this queue. (Note YNAB's
  `type: "uncategorized"` is a separate axis; many rows are both.)

**Write tools:**
- `update_transaction` — `updateTransaction`; categorize/fix one row. **DONE
  2026-06-07**, verified live (NYT row: uncategorized->Content Subscriptions,
  approved false->true). Exposes 8 editable fields (categoryId, payeeName, memo,
  amount [dollars], date, approved, cleared, flagColor); introduces the
  `dollarsToMilliunits` helper (Math.round for FP safety) and the
  `{ transaction }` PutTransactionWrapper. Guards: no-op (no fields) and
  unknown-id both error cleanly; echoes each changed field old->new. Also drove
  the read tools to surface ids (txn/category/account) so Claude can hand
  read-output ids to the write tools.
- `update_transactions` (bulk) — `updateTransactions` with
  `{ transactions: [{ id, category_id, ... }] }`. The cleanup workhorse:
  categorize + approve many rows in one call (see `cleared` vs `approved` above —
  the action is set category + `approved: true`). Every field but `id` is
  optional. First tool to carry the dryRun/echo-back/batch-cap safety machinery.
  **DONE 2026-06-12**, verified live: categorized all 12 uncategorized "The New
  York Times" rows ($18/mo subscription) -> Content
  Subscriptions + approved, then a fresh read confirmed 0 remain (read-your-write
  via the delta cache). Mirrors the single tool's field mapping per row; shares
  the `describeRowChanges` formatter between preview and commit (the `after` arg
  switches the "new" value from caller-intended to YNAB-authoritative). Guards:
  batch cap (`MAX_BULK_TRANSACTIONS = 100`), and unknown-id / no-op rows abort the
  WHOLE batch (no partial writes). Smoke test exercises it in dry-run only.
- `create_transactions` — `createTransaction` via the `{ transactions }` form.
  **DONE 2026-06-12** (renamed plural; one array-based tool handles single + bulk,
  mirroring `update_transactions`). Each row REQUIRES accountId + date + amount
  (dollars); payee/category/memo/approved/cleared/flag optional. Same safety
  shape: dryRun default true, batch cap, and unknown accountId/categoryId aborts
  the whole batch. No "before" state, so the preview renders the rows it WOULD
  create (resolved account+category names) and the commit echoes the new ids.
  Added `getAccountNameMap` helper. Verified live: dry-run preview + unknown-id
  abort (no real write — we have no delete tool yet to undo a test row). Smoke
  test exercises it in dry-run only.
  - ⚠️ **DEDUP DEFERRED (decided 2026-06-12, Rob — option A):** YNAB does NO
    content-based dedup on create — re-posting the same row makes a DUPLICATE.
    The native guard is `import_id` (unique per account; YNAB convention
    `YNAB:<amount_milliunits>:<date>:<occurrence>`; collisions come back in the
    response's `duplicate_import_ids`). We intentionally left `import_id` OUT of
    the first version and will add it when building the **backfill (step 6)**,
    where idempotent, re-runnable imports actually matter. ← *add import_id here*
- `delete_transaction` — `deleteTransaction`; remove dupes/junk. **DONE
  2026-06-12.** Single-row (no dryRun — relies on the client's per-call approval,
  like `update_transaction`): captures the row from the cache BEFORE deleting so
  the echo-back reports what was removed, and fails cleanly on an unknown id.
  Verified live with a full **create -> delete round trip** (created a real test
  row, deleted it, confirmed gone via a forced-refresh read — no residue). Smoke
  test exercises the not-found guard only (delete has no dryRun).

**Transfer support (DONE 2026-06-24).** The write tools couldn't link transfers
(credit-card payments, moves to savings/brokerage, wires) — money moving between
two of your own accounts, which YNAB models as a category-less paired
transaction, NOT spending. Added across `list_accounts` + all three write tools:
- **How YNAB records a transfer (verified against the installed SDK):** there is
  NO writable `transfer_account_id`. You set the transaction's `payee_id` to the
  TARGET account's `transfer_payee_id` (a hidden per-account "money into me"
  payee); YNAB then auto-creates the linked mirror row on the other account.
- **`list_accounts`** now surfaces each account's `transferPayeeId` (the enabler
  + auditability).
- **Design (Option 1 — friendly):** the write tools take a `transferAccountId`
  (a normal account id from `list_accounts`); the tool resolves it to that
  account's `transfer_payee_id` internally and sends it as `payee_id`. Claude
  never hand-carries the raw payee id. Added to `update_transaction` (single),
  `update_transactions` (bulk), and `create_transactions`.
- **Guards (mirror the existing safety posture):** `transferAccountId` and
  `payeeName` conflict (both set the payee → rejected); a transfer into the row's
  OWN account is rejected; an unknown `transferAccountId` is rejected. On the
  bulk/array tools these abort the WHOLE batch (no partial writes), consistent
  with the unknown-id handling. Previews/echo-back render the transfer as
  "Transfer : <target account>".
- **Verified in dry-run** against the real budget via the smoke test (new
  transfer case); **live linking deferred** — will be done "in prod" when next
  reconciling the Chase CC payment lines (it's a real write).
- Unblocks the deferred **Chase CC payment** rows from the 2026-06-21 backlog
  cleanup (left untouched precisely because transfers weren't supported) + the
  Fidelity/wire transfer rows.

**✅ Milestone 4 write tools COMPLETE (2026-06-12; transfer support added
2026-06-24):** `update_transaction`, `update_transactions`, `create_transactions`,
`delete_transaction` all built and verified live, now with transfer linking. The
cleanup workflow has its full toolset. Remaining M4 work is using them
(categorize the backlog incl. the now-linkable Chase CC payments) + the Amazon
disambiguation study (program step 2). Still owed: `import_id` on create before
the backfill (step 6).

**New concepts introduced here:**
- Nested request-body wrappers: inputSchema grows from flat fields to nested
  `z.object(...)` shapes.
- Dollars -> milliunits, the reverse of `formatMilliunits` (Claude thinks in
  dollars; YNAB stores integer milliunits).
- Bulk arrays of objects as input.
- Side effects on real financial data (see Safety below).

### Milestone 5 — Phase 2: configure the budget
Reshape the budget structure based on the M4 analysis.

> Codebase note (session #8): the server was refactored into domain modules
> (`docs/refactor-plan.md`, Phases 1–3 ✅). M5's tools are born in their OWN
> `src/tools/categories.ts` via a `registerCategoryTools(server, api)` function —
> not the old monolith. New helpers (e.g. a category-group lookup) go in
> `src/ynab/lookups.ts`. Keep tool names `snake_case verb_noun`.

- `create_category_group` — `createCategoryGroup`; new top-level groupings.
- `create_category` — `createCategory`; new categories within a group.
- `update_category` — `updateCategory`. Body includes `category_group_id`, so
  this also MOVES a category between groups, not just rename/hide.
- `update_category_group` — `updateCategoryGroup`; rename a group.
- `assign_to_category` — `updateMonthCategory`; budget money to a category for
  a given month (the core YNAB action).

## Cross-cutting: safety posture (decided 2026-06-06)
**Blast radius is bounded (clarified 2026-06-12).** YNAB is a budget *tracking*
application — these tools mutate the budget's bookkeeping records (categories,
approved/cleared flags, memos), NOT actual money. Nothing here can move funds,
pay a bill, or touch a real bank account. The worst case of a misfired write is
corrupted *tracking* data, and even that is recoverable: re-download the
transaction data from the linked banks and start over. So the safety machinery
below is about keeping the bookkeeping clean and the conversation auditable, NOT
about preventing financial loss — there is no financial loss to prevent.

With that framing, a misfired `update_transactions` could still mis-categorize
hundreds of rows (annoying to untangle), so the guards remain worthwhile. The
MCP client already prompts the user to approve every tool call; these add
protection on top of that:

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
