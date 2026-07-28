// Export the COMPLETE transaction history for a budget straight from the YNAB
// API (same SDK + since_date floor as the server's cache, but bypassing MCP) and
// write it out for offline analysis. Produces three files in the output dir:
//   transactions.json — full-fidelity raw TransactionDetail array
//   transactions.csv  — flattened rows (splits emitted as child rows too)
//   README.md         — provenance: when pulled, counts, date range
// Run from the repo root (token comes from .env, never printed):
//   npx tsx --env-file=.env scripts/export-transactions.ts <budgetId> <outDir>
import * as fs from "node:fs";
import * as path from "node:path";
import * as ynab from "ynab";
import { createYnabClient } from "../src/ynab/client.js";

const [budgetId, outDir] = process.argv.slice(2);
if (!budgetId || !outDir) {
  console.error(
    "Usage: npx tsx --env-file=.env scripts/export-transactions.ts <budgetId> <outDir>",
  );
  process.exit(1);
}

const api = createYnabClient(process.env.YNAB_TOKEN);

// Same explicit floor the server's cache uses — without it YNAB returns only a
// trailing ~12-month window (Bug #1).
const response = await api.transactions.getTransactions(budgetId, "1900-01-01");
const transactions = response.data.transactions
  .filter((t) => !t.deleted)
  .sort((a, b) => a.date.localeCompare(b.date));

if (transactions.length === 0) {
  console.error("No transactions returned — refusing to write an empty export.");
  process.exit(1);
}
const oldest = transactions[0].date;
const newest = transactions[transactions.length - 1].date;

// CSV helpers: quote everything, double embedded quotes, strip newlines.
function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value).replace(/\r?\n/g, " ");
  return `"${s.replaceAll('"', '""')}"`;
}
const HEADER = [
  "id",
  "parent_id", // set on split children; empty on ordinary rows and parents
  "date",
  "amount_dollars",
  "payee",
  "category",
  "account",
  "memo",
  "cleared",
  "approved",
  "flag_color",
  "transfer_account_id",
  "import_id",
];
const rows: string[] = [HEADER.join(",")];
for (const t of transactions) {
  rows.push(
    [
      t.id,
      "",
      t.date,
      (t.amount / 1000).toFixed(2),
      t.payee_name,
      t.category_name,
      t.account_name,
      t.memo,
      t.cleared,
      t.approved,
      t.flag_color,
      t.transfer_account_id,
      t.import_id,
    ]
      .map(csvCell)
      .join(","),
  );
  // Splits: the parent's category is "Split"; the real categories live on the
  // subtransactions, so emit each as a child row for category-level analysis.
  for (const sub of t.subtransactions) {
    if (sub.deleted) continue;
    rows.push(
      [
        sub.id,
        t.id,
        t.date,
        (sub.amount / 1000).toFixed(2),
        sub.payee_name ?? t.payee_name,
        sub.category_name,
        t.account_name,
        sub.memo,
        t.cleared,
        t.approved,
        t.flag_color,
        sub.transfer_account_id,
        "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
}

// Provenance note so the export is self-describing when found later.
const pulledAt = new Date().toISOString();
const readme = `# YNAB transaction export

- **Budget id:** ${budgetId}
- **Pulled:** ${pulledAt} (UTC), direct from api.ynab.com via the official SDK
- **How:** \`scripts/export-transactions.ts\` in the ynab-mcp-server repo,
  \`GET /budgets/{id}/transactions?since_date=1900-01-01\` (explicit floor — see Bug #1)
- **Rows:** ${transactions.length} transactions (deleted excluded), ${oldest} -> ${newest}
- **Files:** \`transactions.json\` (raw, full fidelity) · \`transactions.csv\`
  (flattened; split transactions ALSO emit one child row per subtransaction with
  \`parent_id\` set — sum the parents OR the children for a total, not both)
- **Amounts:** CSV \`amount_dollars\` is dollars (negative = outflow). JSON
  \`amount\` is YNAB milliunits (1000 = $1.00).
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, "transactions.json"),
  JSON.stringify(transactions, null, 1),
);
fs.writeFileSync(path.join(outDir, "transactions.csv"), rows.join("\n") + "\n");
fs.writeFileSync(path.join(outDir, "README.md"), readme);

console.log(
  `Exported ${transactions.length} transactions (${oldest} -> ${newest}) to ${outDir}`,
);
