// The delta-synced transaction cache. Extracted in the Phase 3 split.
//
// Two things to notice about the DI boundary here:
//   - getAllTransactions takes `api` as an explicit parameter (injected by the
//     caller) instead of closing over a module-global client — that's the
//     dependency-injection move the split is teaching.
//   - the cache Map itself STAYS module-level. It's shared process state (one
//     cache per running server), not a per-call collaborator, so it's correctly
//     a module singleton, not something to inject. That contrast — injected
//     collaborator vs shared singleton — is the durable lesson.
import * as ynab from "ynab";
import { ynabCall } from "./client.js";

// One cache entry per budget:
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

// YNAB's GET /transactions with NO since_date does NOT return the whole budget —
// it returns only a trailing ~12-month window (verified against api.ynab.com
// 2026-07-28; Bug #1). A full fetch must pass an explicit floor date to get
// everything. Delta calls still pass undefined: serverKnowledge governs those,
// and passing both would ask YNAB an ambiguous question we don't need answered.
const FULL_FETCH_SINCE_DATE = "1900-01-01";

// Tolerance for the truncation guard below. first_month is the FIRST DAY of the
// budget's first month, so the oldest transaction can legitimately land later
// in that month (27 days later on this budget). One quarter cleanly separates
// that from the failure being guarded against (~9 years of missing history).
const TRUNCATION_TOLERANCE_DAYS = 92;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Returns the complete, current transaction set for a budget; callers apply
// their own date/type/paging filters on top. forceRefresh discards the cache
// and re-downloads everything from scratch.
export async function getAllTransactions(
  api: ynab.API,
  budgetId: string,
  forceRefresh: boolean,
): Promise<ynab.TransactionDetail[]> {
  const cached = forceRefresh ? undefined : transactionCache.get(budgetId);

  // Full fetch (no cache): pass the explicit since_date floor — without it YNAB
  // silently returns only the trailing ~12 months (Bug #1). Delta fetch (cache
  // present): since_date stays undefined; the serverKnowledge cursor decides
  // what comes back.
  const response = await ynabCall(
    api.transactions.getTransactions(
      budgetId,
      cached ? undefined : FULL_FETCH_SINCE_DATE,
      undefined,
      cached?.serverKnowledge,
    ),
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

  // Full fetches get cross-checked against the budget's own first_month; a
  // cache that starts materially later than the budget itself is always a bug.
  if (!cached) await warnIfTruncated(api, budgetId, byId);

  return [...byId.values()];
}

// The truncation guard. This class of bug (Bug #1) produces confident,
// well-formed, silently-wrong answers, so the fix comes with an alarm: after a
// full fetch, compare the cache's oldest transaction date against the budget's
// first_month from the plans summary. Diagnostics must never break a working
// read — this only warns on stderr, and swallows its own failures.
async function warnIfTruncated(
  api: ynab.API,
  budgetId: string,
  byId: Map<string, ynab.TransactionDetail>,
): Promise<void> {
  try {
    const response = await ynabCall(api.plans.getPlans());
    const firstMonth = response.data.plans.find(
      (p) => p.id === budgetId,
    )?.first_month;
    if (!firstMonth || byId.size === 0) return; // nothing to compare against

    let oldest: string | undefined;
    for (const txn of byId.values()) {
      if (oldest === undefined || txn.date < oldest) oldest = txn.date;
    }
    if (oldest === undefined) return;

    const gapDays = (Date.parse(oldest) - Date.parse(firstMonth)) / MS_PER_DAY;
    if (gapDays > TRUNCATION_TOLERANCE_DAYS) {
      console.error(
        `[cache] ⚠️ TRUNCATION SUSPECTED for ${budgetId}: oldest cached ` +
          `transaction is ${oldest}, but the budget's first month is ` +
          `${firstMonth}. The cache is likely missing history — this is the ` +
          `Bug #1 failure class.`,
      );
    }
  } catch (e) {
    console.error(
      `[cache] truncation guard skipped (plans lookup failed): ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
