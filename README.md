# ynab-mcp-server

A local [MCP](https://modelcontextprotocol.io) server that gives Claude read and
write access to a [YNAB](https://www.ynab.com) budget: list budgets, accounts,
categories and transactions; import pending bank transactions; create, update
and delete transactions one at a time or in bulk. Built to clean up years of
unattended bank-linked data and to make the weekly "categorize what came in"
chore a conversation instead of a click-fest.

TypeScript, Node 22+, the official `@modelcontextprotocol/sdk` and the `ynab`
SDK. Talks to Claude over stdio.

## Safety model

- Reads are always safe.
- Writes mutate bookkeeping in YNAB, never real money.
- Every bulk write defaults to `dryRun: true` and returns a preview; pass
  `dryRun: false` to commit. Batches are capped, every row is validated before
  anything is written, and the tool echoes back what it changed.
- Transactions are cached locally with YNAB's delta sync, so repeated reads are
  cheap and a write is visible on the next read.

## Tools

| Tool | What it does |
|---|---|
| `list_budgets` | Budgets on the account, with ids. Start here. |
| `list_accounts` | Accounts in a budget: type, balance, linked status. |
| `list_categories` | Category groups and categories, with budgeted and available amounts. |
| `list_transactions` | Transactions with paging and filters (account, category, type, date, unapproved, uncategorized). |
| `import_transactions` | Pull pending transactions from linked bank accounts. Additive; YNAB dedupes on import id. |
| `update_transaction` | Change one transaction (category, payee, memo, approval, flag, date, amount). |
| `update_transactions` | The same across many transactions in one call, dry-run by default. |
| `create_transactions` | Create one or many transactions, dry-run by default. |
| `delete_transaction` | Delete one transaction. |

## Setup

1. Create a Personal Access Token in YNAB (Account Settings, Developer Settings).
2. `npm install`
3. Create `.env`:
   ```
   YNAB_TOKEN=your-token
   YNAB_LIVE_BUDGET=Name of the budget the smoke test may import into
   ```
   `.env` is gitignored. Never commit it.
4. `npm run build`
5. Point Claude Desktop (or Claude Code) at the compiled server:
   ```json
   {
     "mcpServers": {
       "ynab": {
         "command": "node",
         "args": ["--env-file=/absolute/path/to/.env", "/absolute/path/to/dist/server.js"]
       }
     }
   }
   ```

`npm run dev` runs the TypeScript directly with `tsx` for development.
`npm run smoke` builds and runs `scripts/smoke-test.ts`, which exercises every
tool against the real account (reads, one real import into the budget named in
`YNAB_LIVE_BUDGET`, and dry-run writes).

## Layout

```
src/server.ts          thin entry: builds the client, registers tools, connects stdio
src/tools/             tool registrations: read, transactions-write, transactions-import
src/ynab/              API client, delta-sync cache, id/name lookups
src/lib/               pure helpers: money (milliunits), zod schemas
scripts/               smoke test, transaction export
docs/                  roadmap and design notes, YNAB endpoint map
```

## How this was built

Built in [Claude Code](https://claude.com/claude-code) as a learning project,
one tool at a time. I set the design and the safety rules, review every change
and run the smoke test against my own budget; Claude writes most of the code,
which is why each commit carries its co-author line. `docs/roadmap.md` is the
running log of what was built, in what order, and why.

## License

ISC
