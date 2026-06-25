// Money conversions between YNAB's integer "milliunit" storage and dollars.
// Pure functions, no dependencies — the first leaf extracted in the Phase 3
// split. Imported elsewhere as "../lib/money.js" (the ".js" is the Node ESM
// rule under nodenext — the compiled name, even though the source is .ts).

// YNAB stores every monetary amount as an integer "milliunit": 1000 = $1.00,
// so -43210 milliunits = -$43.21. Divide by 1000 and format as currency once,
// here, so the tools never repeat this conversion.
//
// Intl.NumberFormat is a built-in JS API (the ECMAScript Internationalization
// API) — no import, no dependency. "en-US" picks the grouping/decimal style
// (1,234.56) and { style: "currency", currency: "USD" } adds the $ and the
// fixed 2 decimals, including correct negative signs. Currency is hardcoded to
// USD for now; YNAB budgets carry their own currency_format we can honor later.
export function formatMilliunits(milliunits: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(milliunits / 1000);
}

// The inverse of formatMilliunits, for the WRITE path: Claude thinks in dollars
// (43.21), YNAB stores integer milliunits (43210). Multiplying by 1000 isn't
// enough — binary floating point can't represent 43.21 exactly, so
// 43.21 * 1000 === 43209.99999999999, not 43210. Math.round snaps to the
// nearest whole milliunit, which is what YNAB requires. Negative amounts
// (outflows) round correctly too: Math.round(-43209.9999) === -43210.
export function dollarsToMilliunits(dollars: number): number {
  return Math.round(dollars * 1000);
}
