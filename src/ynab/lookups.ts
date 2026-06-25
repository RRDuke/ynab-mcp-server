// Id -> name (and id -> transfer-payee) lookups the write tools use to validate
// ids and render readable previews. Extracted in the Phase 3 split; each takes
// `api` explicitly (dependency injection) rather than closing over a global.
import * as ynab from "ynab";
import { ynabCall } from "./client.js";

// A budget's category ids -> names, flattened from the grouped getCategories
// shape. Lets a dry-run preview show a category NAME for the id the caller passed
// (e.g. "uncategorized -> Content Subscriptions") instead of a raw id.
export async function getCategoryNameMap(
  api: ynab.API,
  budgetId: string,
): Promise<Map<string, string>> {
  const response = await ynabCall(api.categories.getCategories(budgetId));
  const map = new Map<string, string>();
  for (const group of response.data.category_groups) {
    for (const c of group.categories) map.set(c.id, c.name);
  }
  return map;
}

// Both account-keyed maps the write tools need, from ONE getAccounts request:
//   names         — account id -> name (validate accountId, readable preview)
//   transferPayees — account id -> transfer_payee_id (the hidden payee meaning
//                    "money moving INTO this account"; how YNAB records a
//                    transfer — set a transaction's payee_id to the TARGET
//                    account's transfer_payee_id and YNAB auto-creates the mirror
//                    row). The friendly `transferAccountId` a tool accepts is
//                    resolved through this map to the payee_id YNAB wants.
// Both skip deleted accounts. This merges what used to be two separate helpers
// (getAccountNameMap + getAccountTransferPayeeMap) that each fired their own
// byte-identical getAccounts call — the bulk tools needed both, so that was two
// round-trips for one budget's accounts. One loop, one request now.
export async function getAccountMaps(
  api: ynab.API,
  budgetId: string,
): Promise<{ names: Map<string, string>; transferPayees: Map<string, string> }> {
  const response = await ynabCall(api.accounts.getAccounts(budgetId));
  const names = new Map<string, string>();
  const transferPayees = new Map<string, string>();
  for (const a of response.data.accounts) {
    if (a.deleted) continue;
    names.set(a.id, a.name);
    transferPayees.set(a.id, a.transfer_payee_id);
  }
  return { names, transferPayees };
}
