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

// Returns the complete, current transaction set for a budget; callers apply
// their own date/type/paging filters on top. forceRefresh discards the cache
// and re-downloads everything from scratch.
export async function getAllTransactions(
  api: ynab.API,
  budgetId: string,
  forceRefresh: boolean,
): Promise<ynab.TransactionDetail[]> {
  const cached = forceRefresh ? undefined : transactionCache.get(budgetId);

  // Fetch the WHOLE budget (no sinceDate/type) so the cache stays complete and
  // delta sync stays coherent. cursor undefined on the first call -> full set.
  const response = await ynabCall(
    api.transactions.getTransactions(
      budgetId,
      undefined,
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
  return [...byId.values()];
}
