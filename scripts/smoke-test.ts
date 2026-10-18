// Throwaway smoke test — acts as a tiny "Claude" to prove the server works
// end to end before we wire up the real Claude. Run with:
//   npx tsx smoke-test.ts
// Delete it once we've confirmed the green light.
//
// NOTE: console.log is fine HERE — this is the CLIENT; its stdout is our
// terminal, not an MCP protocol channel.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The transport launches our server as a child process — the SAME way Claude
// will. node loads the token from .env via --env-file; we pass nothing secret.
const transport = new StdioClientTransport({
  command: "node",
  args: ["--env-file=.env", "dist/server.js"],
});

const client = new Client({ name: "smoke-test", version: "0.0.1" });

await client.connect(transport); // spawns server + does the MCP handshake
console.log("Connected. Asking the server what tools it has...\n");

// 1. Discovery — exactly what Claude does to learn the server's capabilities.
const { tools } = await client.listTools();
console.log(
  "Tools advertised:",
  tools.map((t) => t.name),
);
// import_transactions has no dryRun (any call really imports), so the smoke
// test only checks it's advertised and never calls it.
if (!tools.some((t) => t.name === "import_transactions")) {
  console.error("\nFAIL: import_transactions is not advertised.");
  await client.close();
  process.exit(1);
}

// Small helper: call a tool and print the first text block it returns.
// callTool's result.content is the { type, text }[] array our server built.
async function callAndPrint(
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`);
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])
    .map((c) => c.text)
    .join("\n");
  console.log(text);
  return text;
}

// 2. list_budgets (no args) — and scrape the first budget id out of the text
//    so the argument-taking tools below have a real id to work with.
const budgetsText = await callAndPrint("list_budgets");
const budgetId = budgetsText.match(/id: ([0-9a-f-]+)/i)?.[1];
if (!budgetId) {
  console.error("\nCould not find a budget id to test the other tools with.");
  await client.close();
  process.exit(1);
}
console.log(`\n>>> Using budgetId ${budgetId} for the remaining tools.`);

// 3. The argument-taking read tools, against the real budget.
const accountsText = await callAndPrint("list_accounts", { budgetId });
await callAndPrint("list_categories", { budgetId });

// list_transactions: exercise delta caching + paging + the type filter.
// First call = full fetch (watch for the server's "[cache] ... full fetch").
const firstPageText = await callAndPrint("list_transactions", {
  budgetId,
  limit: 3,
});

// Bug #1 regression tripwires. These thresholds are GROUND TRUTH for Rob's real
// budget ("Budgets are kewl"): ~20,855 transactions back to 2016-11-28 as of
// 2026-07-28, growing over time. The truncated cache reported 2,558 rows
// starting 2025-07-28 — so both assertions have wide margins on each side.
const total = Number(firstPageText.match(/of (\d+):/)?.[1] ?? 0);
if (total < 15000) {
  console.error(
    `\nFAIL: cache holds ${total} transactions, expected >= 15,000 — ` +
      `the full fetch looks truncated (Bug #1).`,
  );
  await client.close();
  process.exit(1);
}
// Page directly to the oldest row (newest-first sort => last row is oldest).
const oldestRowText = await callAndPrint("list_transactions", {
  budgetId,
  limit: 1,
  offset: total - 1,
});
const oldestDate = oldestRowText.match(/- (\d{4}-\d{2}-\d{2}) \|/)?.[1];
if (!oldestDate || oldestDate >= "2017-01-01") {
  console.error(
    `\nFAIL: oldest transaction is ${oldestDate ?? "unparseable"}, expected ` +
      `pre-2017 history — the full fetch looks truncated (Bug #1).`,
  );
  await client.close();
  process.exit(1);
}

// Second call = cheap delta reuse ("[cache] ... delta merged"), page 2.
await callAndPrint("list_transactions", { budgetId, limit: 3, offset: 3 });
// Type filter: only rows still needing a category.
const uncategorizedText = await callAndPrint("list_transactions", {
  budgetId,
  type: "uncategorized",
  limit: 5,
});

// 4. update_transactions — DRY RUN ONLY (never writes from the smoke test).
//    Scrape one real transaction id and preview a categorize+approve change.
//    dryRun defaults to true, so this exercises the validate + preview path
//    end to end without mutating anything.
const txnId = uncategorizedText.match(/\(id: ([0-9a-f-]+)\)/i)?.[1];
const categoryId = (
  await callAndPrint("list_categories", { budgetId })
).match(/\(id: ([0-9a-f-]+)\)/i)?.[1];
if (txnId && categoryId) {
  await callAndPrint("update_transactions", {
    budgetId,
    transactions: [{ transactionId: txnId, categoryId, approved: true }],
    // dryRun omitted -> defaults to true -> previews, never writes.
  });
}

// 5. create_transactions — DRY RUN ONLY. Scrape real accountId(s) and preview
//    adding one row. dryRun defaults to true, so nothing is created. (No
//    import_id yet — dedup is deferred to the backfill step; see roadmap.)
//    NOTE: account lines now read "(id: ..., transferPayeeId: ...)", so the id
//    scrape must NOT require a closing paren right after the id.
const accountIds = [...accountsText.matchAll(/\(id: ([0-9a-f-]+)/gi)].map(
  (m) => m[1],
);
const accountId = accountIds[0];
if (accountId) {
  await callAndPrint("create_transactions", {
    budgetId,
    transactions: [
      {
        accountId,
        date: "2026-06-01",
        amount: -1.23,
        payeeName: "Smoke Test",
        memo: "dry-run only",
      },
    ],
  });
}

// 5b. create_transactions TRANSFER — DRY RUN ONLY. With two distinct accounts,
//     preview a transfer FROM accountIds[0] INTO accountIds[1] (the transfer
//     target resolves to that account's transfer payee). Exercises the new
//     transferAccountId path end to end without writing.
if (accountIds.length >= 2 && accountIds[0] !== accountIds[1]) {
  await callAndPrint("create_transactions", {
    budgetId,
    transactions: [
      {
        accountId: accountIds[0],
        transferAccountId: accountIds[1],
        date: "2026-06-01",
        amount: -10.0,
        memo: "transfer dry-run only",
      },
    ],
  });
}

// 6. delete_transaction — exercise the not-found guard with a bogus id. This is
//    SAFE (deletes nothing); the real create -> delete round trip is verified
//    out-of-band with a throwaway when needed, since delete has no dryRun.
await callAndPrint("delete_transaction", {
  budgetId,
  transactionId: "00000000-0000-0000-0000-000000000000",
});

await client.close(); // shuts down the child server process
