# YNAB SDK reference (`ynab@^4.1.0`)

A map of every endpoint in the installed `ynab` SDK, organized by the accessor
you reach it through on a `new ynab.API(token)` instance. Each method is marked
**R** (read / GET) or **W** (write / POST·PUT·PATCH·DELETE).

Notes that apply throughout:

- Every method also takes a trailing optional `initOverrides` arg (request-level
  fetch options), omitted below for readability.
- Most **reads** take an optional `lastKnowledgeOfServer?: number` — YNAB's
  **delta sync** cursor (ask only for what changed since the last call). Also
  omitted below.
- "Plan" is YNAB's v4 name for what the UI calls a **budget**.

## Exposed on `ynabAPI` (lazy getters)

### `.user` — `UserApi`
| Method | R/W | Notes |
|---|---|---|
| `getUser()` | R | The authenticated user's id |

### `.plans` — `PlansApi` (a.k.a. budgets)
| Method | R/W | Notes |
|---|---|---|
| `getPlans(includeAccounts?)` | R | ✅ our `list_budgets` |
| `getPlanById(planId)` | R | Full budget export — *everything* in one call |
| `getPlanSettingsById(planId)` | R | Currency & date format settings |

### `.accounts` — `AccountsApi`
| Method | R/W | Notes |
|---|---|---|
| `getAccounts(planId)` | R | ✅ our `list_accounts` |
| `getAccountById(planId, accountId)` | R | |
| `createAccount(planId, data: PostAccountWrapper)` | W | |

### `.categories` — `CategoriesApi`
| Method | R/W | Notes |
|---|---|---|
| `getCategories(planId)` | R | ✅ our `list_categories` |
| `getCategoryById(planId, categoryId)` | R | |
| `getMonthCategoryById(planId, month, categoryId)` | R | Amounts for a specific month |
| `createCategory(planId, data)` | W | |
| `createCategoryGroup(planId, data)` | W | |
| `updateCategory(planId, categoryId, data)` | W | |
| `updateCategoryGroup(planId, categoryGroupId, data)` | W | |
| `updateMonthCategory(planId, month, categoryId, data)` | W | **Assign money to a category** for a month |

### `.months` — `MonthsApi`
| Method | R/W | Notes |
|---|---|---|
| `getPlanMonths(planId)` | R | Per-month summaries (age of money, to-be-budgeted) |
| `getPlanMonth(planId, month)` | R | One month; `month` = `YYYY-MM-01` or `"current"` |

### `.payees` — `PayeesApi`
| Method | R/W | Notes |
|---|---|---|
| `getPayees(planId)` | R | |
| `getPayeeById(planId, payeeId)` | R | |
| `createPayee(planId, data)` | W | |
| `updatePayee(planId, payeeId, data)` | W | Rename a payee |

### `.payeeLocations` — `PayeeLocationsApi`
| Method | R/W | Notes |
|---|---|---|
| `getPayeeLocations(planId)` | R | GPS coords from the mobile app |
| `getPayeeLocationById(planId, payeeLocationId)` | R | |
| `getPayeeLocationsByPayee(planId, payeeId)` | R | |

### `.transactions` — `CustomTransactionsApi` (extends `TransactionsApi`)
⚠️ `ynabAPI.transactions` is actually a `CustomTransactionsApi` subclass — it has
**all** the base `TransactionsApi` methods *plus* two extras
(`getTransactionsByType`, `createTransactions`).

The `type?` filter on the read methods is the enum `"uncategorized" | "unapproved"`.

| Method | R/W | Notes |
|---|---|---|
| `getTransactions(planId, sinceDate?, type?)` | R | ✅ our `list_transactions` |
| `getTransactionById(planId, transactionId)` | R | |
| `getTransactionsByAccount(planId, accountId, sinceDate?, type?)` | R | |
| `getTransactionsByCategory(planId, categoryId, sinceDate?, type?)` | R | |
| `getTransactionsByMonth(planId, month, sinceDate?, type?)` | R | |
| `getTransactionsByPayee(planId, payeeId, sinceDate?, type?)` | R | |
| `getTransactionsByType(planId, "uncategorized"\|"unapproved")` | R | *(CustomTransactions extra)* |
| `createTransaction(planId, data: PostTransactionsWrapper)` | W | **Single or bulk** — wrapper takes `transaction` *or* `transactions[]` |
| `createTransactions(planId, data)` | W | *(CustomTransactions extra)* explicit bulk |
| `updateTransaction(planId, transactionId, data: PutTransactionWrapper)` | W | |
| `updateTransactions(planId, data: PatchTransactionsWrapper)` | W | Bulk update |
| `deleteTransaction(planId, transactionId)` | W | |
| `importTransactions(planId)` | W | Trigger linked-account import |

### `.scheduledTransactions` — `ScheduledTransactionsApi`
| Method | R/W | Notes |
|---|---|---|
| `getScheduledTransactions(planId)` | R | |
| `getScheduledTransactionById(planId, scheduledTransactionId)` | R | |
| `createScheduledTransaction(planId, data)` | W | |
| `updateScheduledTransaction(planId, scheduledTransactionId, data)` | W | |
| `deleteScheduledTransaction(planId, scheduledTransactionId)` | W | |

## Present in the package but NOT exposed as a getter
Instantiate manually (e.g. `new ynab.DeprecatedApi(config)`) — listed for completeness:

- **`DeprecatedApi`** — `bulkCreateTransactions(budgetId, transactions)` **W**
  *(use `createTransaction` with a `transactions[]` array instead)*
- **`MoneyMovementsApi`** — `getMoneyMovements`, `getMoneyMovementsByMonth`,
  `getMoneyMovementGroups`, `getMoneyMovementGroupsByMonth` — all **R**
  (newer YNAB "money movement" reporting)

## Roadmap alignment
- **Milestone 3 (reads, done):** `getPlans`, `getAccounts`, `getCategories`,
  `getTransactions`.
- **Milestone 4 (writes):** headline targets are
  `transactions.createTransaction` (the big one),
  `transactions.updateTransaction` / `deleteTransaction`, and
  `categories.updateMonthCategory` (assigning money — the core YNAB action).
  These introduce request-body wrappers and dollars → milliunits in reverse.

## Follow-ups / TODO
- [ ] **`list_transactions`: add the optional `type` argument.** The SDK's
  `getTransactions(planId, sinceDate?, type?)` accepts a `type` filter — the enum
  `"uncategorized" | "unapproved"`. Expose it as a third optional inputSchema
  field (`z.enum(["uncategorized", "unapproved"]).optional()`) and pass it through
  as the third positional arg. Lets Claude answer "what's uncategorized?" /
  "what still needs approval?" directly. See the TODO marker in
  `src/server.ts` on the `list_transactions` tool.
