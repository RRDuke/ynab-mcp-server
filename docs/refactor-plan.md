# YNAB MCP server — refactor & hardening plan

_Created 2026-06-24 (build session #6). A planning artifact from a multi-agent
architecture review of `src/server.ts`. **No code was changed to produce this** —
it's the roadmap for the cleanup work, sequenced to keep the smoke test green and
to maximize the learning value of each step. Companion to `docs/roadmap.md` (the
feature roadmap); this doc is the *internal quality* roadmap._

## Headline verdict

**The MCP is designed well — this is not a rescue job.** The tool surface is
genuinely strong: excellent tool descriptions, idiomatic `registerTool` usage,
tight zod schemas, a clean read/write split, and a properly delta-synced
transaction cache. Keep all of that.

**But two things are true at once:**

1. **The single `src/server.ts` (now 1,421 lines, 8 tools) has crossed the line
   where one file hurts more than it helps.** Milestone 5's five category tools
   would push it past ~1,700. The fix is a **moderate, group-by-domain split into
   ~6 files** — _not_ a per-tool explosion, a framework, or a registry. Do it
   **before M5** so the first category tool is born in its own module.

2. **Two real correctness bugs are hiding under the size discussion** and are
   independent of any refactor — fix them first:
   - **YNAB API errors reach Claude as the literal string `"[object Object]"`.**
     Verified: `ynab/dist/runtime.js:164` does `throw await response.json()` — on a
     non-2xx (bad id → 400, rate-limit → 429) the SDK throws a **plain object**,
     not an `Error`; the MCP SDK stringifies it to `"[object Object]"`. A 429, a
     400, and a dead network are indistinguishable to Claude at the one moment the
     error text matters most. (True network failures throw a real `FetchError`, so
     those are fine — it's specifically YNAB *API* errors that turn to mush.)
   - **Every hand-built guard/abort returns a success-shaped result** with no
     `isError: true`. The SDK only sets `isError` on a *throw*, so all our
     `Aborted — nothing written` returns are protocol-level **successes** — Claude
     is told a refused write succeeded and must infer failure from the English
     word "Aborted." That quietly undercuts the whole safe-write story.

**So the order is:** correctness + cheap metadata wins first (Phase 1), then the
in-place DRY cleanup (Phase 2), then the structural split (Phase 3), then targeted
efficiency/remaining DRY (Phase 4). Quick wins before structure; the smoke test is
the regression net throughout.

> **Fact corrections** the review surfaced (the code grew since the notes were
> written): the file is **1,421 lines** (not ~1,180) and registers **8 tools**
> (not 7) — `list_budgets`, `list_accounts`, `list_categories`,
> `list_transactions`, `update_transaction`, `update_transactions`,
> `create_transactions`, `delete_transaction`.

## What's already good — leave it alone

- **The `.js`-extension discipline on ESM imports** (and the comment explaining
  *why* under nodenext) — any new internal module must follow the same rule:
  `import { registerReadTools } from "./tools/read.js"`.
- **The delta-synced transaction cache** (`getAllTransactions` + `server_knowledge`
  cursor). It even self-heals after our own writes. **Do not add cache-invalidation
  machinery** — the next delta merge picks up our writes; that property is correct.
- **Helpers are already single-responsibility functions** written as if they'd be
  extracted, so the split is mostly cut-and-paste, not redesign.
- **The numbered section banners** (`--- 8. Register the write tool ... ---`) — they
  already map onto a file tree; the numbers become module order.
- **The incremental one-file-per-stage build was the right call up to now.**
  Watching one file grow until it hurts *is* the lesson that motivates the split.

---

## Phase 1 — Correctness & protocol honesty (no refactor)

**Goal:** fix the two real bugs and make the MCP signal trustworthy, all inside the
current single file so each change is independently verifiable and low-risk.

**Teaching focus:** verifying thrown shapes against the *installed* SDK; the MCP
`isError` contract (a control-flow channel, distinct from human-readable text);
SDKs can throw non-`Error` values; DRYing repeated returns through a tiny helper.

- [x] **Unwrap YNAB API errors** — add a `ynabErrorText(e)` helper that narrows with
  the SDK's exported `ynab.instanceOfErrorResponse` guard and returns
  `YNAB API error: <name> — <detail>`, falling back to `e.message` / `String(e)`.
  Wrap each tool callback body (or factor a `runTool(fn)` wrapper) to return
  `{ content: [{ type: "text", text: ynabErrorText(e) }], isError: true }`.
  _Why:_ turns `"[object Object]"` into an actionable message exactly when it
  matters. **(small)**
- [x] **Add `isError: true` to every hand-built refusal/abort return** — the
  conflict / unknown-id / no-op / self-transfer / bad-account / batch-cap / bulk
  abort / delete-not-found blocks. **Leave `dryRun` previews and real successes
  without it.** A tiny `fail(text)` helper DRYs the ~13 sites.
  _Why:_ makes "this write was refused" a fact the client can act on, not prose to
  parse. **(small)**
- [x] **Declare tool annotations on all 8 tools** — reads `{ readOnlyHint: true,
  openWorldHint: true }`; update/create `{ destructiveHint: true,
  idempotentHint: false }`; delete `{ destructiveHint: true, idempotentHint: true }`.
  _Why:_ `registerTool`'s config accepts `ToolAnnotations` (verified in the
  installed SDK); the read-vs-write distinction currently lives only in prose the
  host can't act on. Makes approval-gating decidable structurally. **(small)**
- [x] **Add a server-level `instructions` string** to the `McpServer` options
  ("Tools for the user's YNAB budget. Reads are safe; writes mutate bookkeeping —
  not real money. Bulk writes default to dryRun.") and a one-line comment that
  `snake_case verb_noun` tool names are the deliberate MCP convention (so M5 tools
  don't drift to camelCase). **(small)**

---

## Phase 2 — Schema & type single-source-of-truth (in-place DRY)

**Goal:** collapse the duplicated zod validators, enum unions, and hand-written row
types into composed, derived definitions — still in the single file, so the win is
verifiable before any file moves.

**Teaching focus:** zod schemas as first-class composable values; `z.infer` makes
the static type *follow* the schema (the bug-prevention TS exists for); sourcing
enums from the dependency that owns them; structural typing. This is the
highest-teaching-value cluster, and the duplication is **already drifting** (the
`transferAccountId` blurb is worded three different ways).

- [x] **Build zod enums from the YNAB SDK constants** — done a touch differently
  from the recipe above, after a type probe against installed zod 4: the SDK
  exports are `as const` objects, and zod 4's `z.enum` accepts the object form
  directly and infers the value union — so `clearedEnum = z.enum(ynab.TransactionClearedStatus)`
  and `flagColorEnum = z.enum(ynab.TransactionFlagColor).exclude(["Empty"])`. The
  object form was chosen over `Object.values(...).filter(...)` because a plain
  `.filter()` does NOT narrow the array element type (the `""` survives in the
  inferred type), whereas `.exclude` by member name keeps the literal union clean.
  Fed to `z.enum` at all three sites. **(small)**
- [x] **Define shared editable-field validators and compose them** — implemented as
  `txnOptionalFields` (the seven always-optional fields, each fully-formed with one
  canonical description) spread into all three schemas, plus two standalone base
  validators `dollarAmount` / `isoDate` (kept base because amount/date are optional
  on update but required on create — each tool adds optionality + wording). Net
  ~90 lines deleted and the three-way drift in the `transferAccountId`/cleared/etc.
  blurbs collapsed to one source. Field order shifted (cosmetic — handler
  destructures by name). **(medium)**
- [x] **Derive `BulkRow` / `NewRow` with `z.infer`** — pulled each array element into
  `bulkRowSchema` / `newRowSchema` and replaced the hand-written types with
  `z.infer<typeof …>`. The clean compile is the proof (the formatters consume the
  types). Comment notes `z.infer` (output) vs `z.input` coincide here because the
  only `.default()` (dryRun) lives in the top-level shape, not the rows. **(small)**

---

## Phase 3 — Structural split (leaf-up, smoke-test green at each step)

**Goal:** decompose the now-clean file into a thin entry + `ynab/` + `lib/` +
`tools/` modules wired by `register*(server, api)` functions, injecting the `api`
client as the module-global closures disappear.

**Teaching focus:** **dependency injection** (pass `api` in) **vs module-level
singleton** (the cache legitimately *stays* in module scope — shared process
state); the register-function convention every sizeable MCP server uses; nodenext
`.js`-extension discipline on new internal imports; safe-refactor discipline with a
green checkpoint at every step.

> **This is the answer to the original question** ("is this designed efficiently?
> should we refactor?") and the highest-payoff change — but also the riskiest, so it
> rides on the smoke test and goes after the cheap wins. The DI step (threading
> `api` through every helper and register function) is **not** a pure file move —
> it *is* the real work and the teaching payoff. Budget for it.

**Target tree (group by domain, ~6 files — not one-file-per-tool):**

```
src/server.ts                  — thin entry (~40 lines): read token, build api +
                                 McpServer (with Phase-1 instructions), call the
                                 register*() functions, connect stdio.
src/ynab/client.ts             — createYnabClient(token): env-check + new ynab.API.
src/ynab/cache.ts              — TransactionCacheEntry + transactionCache +
                                 getAllTransactions. (cache Map STAYS module-level.)
src/ynab/lookups.ts            — the three get*Map helpers (id → name / transfer payee).
src/lib/money.ts               — formatMilliunits, dollarsToMilliunits.
src/lib/schemas.ts             — the Phase-2 shared validators / enums / derived types.
src/tools/read.ts              — registerReadTools(server, api).
src/tools/transactions-write.ts— registerTransactionWriteTools(server, api) +
                                 the formatters (describeRowChanges, rowHeader,
                                 describeNewRow — their only consumers).
(M5) src/tools/categories.ts   — registerCategoryTools(server, api). Born here, not
                                 in the monolith.
```

**Migration order (run `npm run build && npx tsx scripts/smoke-test.ts` after EACH):**

- [x] **1. Pure leaves first** — `src/lib/money.ts` (30 lines) and
  `src/lib/schemas.ts` (113). No client dependency; proved the nodenext
  `.js`-import wiring without touching the closure problem. **(small)**
- [x] **2. `src/ynab/cache.ts` + `src/ynab/lookups.ts`, injecting `api`** — each
  helper now takes an explicit `api` param: `getAllTransactions(api, budgetId,
  forceRefresh)`, `getAccountMaps(api, budgetId)`, `getCategoryNameMap(api,
  budgetId)`. `transactionCache` Map STAYS module-level (the injected-collaborator
  vs shared-singleton contrast). The error boundary (`ynabErrorText`/`ynabCall`)
  moved to `ynab/client.ts`. Folded in the Phase-4 `getAccountMaps` merge: the two
  byte-identical `getAccounts` calls the bulk tools fired are now one. **(medium)**
- [x] **3. Wrap registrations** — read tools in `registerReadTools(server, api)`
  (`tools/read.ts`, 275), the four write tools + formatters + `fail` in
  `registerTransactionWriteTools(server, api)` (`tools/transactions-write.ts`,
  796), `createYnabClient` in `ynab/client.ts`. `server.ts` is now a 66-line thin
  entry (was 1,124). Smoke green after each step; all 8 tools verified identical.
  **(medium)**

---

## Phase 4 — Targeted efficiency & remaining DRY (opportunistic)

**Goal:** remove the genuinely wasteful round-trips and the last duplication,
framing the in-memory ones honestly as **clarity** wins, not speed.

**Teaching focus:** fetch-once-derive-many; don't serialize independent I/O
(`Promise.all`); don't discard the index you already built; DRYing repeated MCP
envelopes. Lower severity than Phases 1–3, and partly lands for free during the
Phase-3 extraction.

- [x] **Merge the two `getAccounts` calls into one `getAccountMaps()`** returning
  `{ names, transferPayees }` from a single `getAccounts` loop — **done during
  Phase 3** (folded into the `ynab/lookups.ts` extraction). Each bulk write now
  fires one `getAccounts` request, not two. _Still open (minor):_ wrap the
  independent category + account reads in `Promise.all` — one serial await per
  bulk write. **(small)**
- [ ] **Extract `textResult()` / `fail()` and a field-mapping helper** —
  `textResult = (text) => ({ content: [{ type: "text" as const, text }] })` (the
  `as const` is *required* so the factory matches the SDK's literal-typed content
  union — a real teaching point), routed through the ~20+ envelope returns. Extract
  `applySharedFields(target, row)` for the 8-field snake_case mapping duplicated
  across the single/bulk-update/create commits. **Leave `payee_id` transfer
  resolution at each call site** — the three paths genuinely differ. **(medium)**
- [ ] **Expose a `getTransactionById` accessor** so `update_transaction` and
  `delete_transaction` stop doing `getAllTransactions().find()` and the bulk tool
  stops rebuilding `new Map(all.map(...))`. Return an **accessor, not the raw
  mutable Map** (avoids cache-corruption footguns). _Be honest with yourself:_ the
  runtime win is ~zero (network dominates) — do it for the pattern. **(small)**
- [x] **Honesty pass** — **dropped** the "No future dates" claim from both date
  descriptions (it was unenforced by our code, so the tool was misdescribing its
  own behavior); added a "NOT idempotent — committing the same rows twice creates
  duplicates" caveat to `create_transactions` (with `import_id` dedup still
  **deferred to the backfill step**, program step 6). Left the split-parent note
  as-is on `categoryId` ("can't be changed on a split") — accurate; did not assert
  amount/date split-parent behavior without verifying it. **(small as done)**

> Still open (all explicitly optional polish — file is clean enough that none is
> pressing): `Promise.all` on the two independent bulk reads; `textResult()` /
> `applySharedFields()` DRY; `getTransactionById` accessor (runtime win ~zero).

---

## Deliberately leave alone (anti-over-engineering)

These were considered and **explicitly rejected** for a local personal teaching
tool — recording them so they're not re-litigated:

- **No `outputSchema` / `structuredContent` codebase-wide.** The only consumer is
  Claude reading clean, id-bearing prose; it'd force a parallel zod schema + dual
  emitting text *and* structured content. _(Optional: try it on `list_accounts`
  alone someday as a one-tool drill.)_
- **No converting reads to MCP Resources.** The real client drives reads via tool
  calls mid-reasoning to get ids for writes; `list_transactions` is
  parameterized/paged (tool-shaped); `list_budgets` is referenced by other tools'
  descriptions.
- **No over-splitting** — no one-file-per-tool, no registry/auto-loader, no base
  classes, no DI container. Cap at ~6 files grouped by domain.
- **Don't collapse the three `get*Map` helpers** into one selector-parameterized
  helper — three named functions are clearer here.
- **Don't merge the single `update_transaction` echo into `describeRowChanges`** —
  they only *look* like duplicates (the single tool always has a real `after`;
  `describeRowChanges` juggles three sources + the no-`after` dry-run case). Add a
  comment noting the divergence is intentional.
- **Don't build a standalone `overBulkCap()` helper** — only 2 identical sites and
  no third coming (M5 tools are all singular). Fold it in opportunistically if a
  `textResult` helper appears.
- **Don't build real subtransaction editing or a reconciled-row guard** — ceremony
  for this tool.

## Sequencing & safety notes

- **The smoke test loads compiled `dist/server.js`, not the TS source**, and there's
  no npm script for it — the real checkpoint is
  `npm run build && npx tsx scripts/smoke-test.ts`. Forgetting the build tests stale
  code. _(Quick win: add an `npm run smoke` script.)_
- **The smoke test scrapes tool OUTPUT TEXT, not just names/schemas.** During pure
  file-moves keep output strings byte-identical; the Phase-1 `isError`/annotations/
  error-helper changes intentionally change behavior, so run the smoke test after
  each and update text assertions deliberately.
- **Phase 1 before any future-date guard:** the guard's whole value is turning a
  YNAB 400 (currently `"[object Object]"`) into a readable message — fix the error
  path first.
- **Do the split before Milestone 5, not after** — starting M5 first means
  refactoring ~1,700+ lines and the first category tool is born in the monolith.
- **Go leaf-up within the split** so every step is bisectable; the DI threading is
  the real work, not cut-and-paste.

## Review provenance

Produced by a 6-dimension multi-agent review (organization, efficiency,
correctness, MCP design, TypeScript idioms, duplication), each finding
adversarially verified against the **installed** packages (MCP SDK 1.29.0, zod
4.4.3, ynab 4.1.0) — 33 findings, 32 confirmed worth-doing. Key claims
independently re-verified by hand: the `runtime.js:164` throw shape, the missing
`isError` on guards, the double `getAccounts` fetch, and the SDK's support for
annotations / `outputSchema` / `isError`.
