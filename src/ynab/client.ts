// The YNAB API boundary: client construction plus the error-normalizing call
// wrapper and its helper. Extracted in the Phase 3 split so the cache, lookups,
// and tools can all share one error boundary.
import * as ynab from "ynab";

// Build the YNAB API client from the token. The real value lives only in the
// gitignored .env file, loaded via Node's native --env-file flag at run time (no
// "dotenv" dependency). Fail fast with a clear message if it's absent — the
// `process.exit(1)` returns `never`, which narrows `token` to string for the
// constructor below. The token grants full read/write to every budget and stays
// server-side: Claude only ever sees tool inputs/outputs, never this credential.
export function createYnabClient(token: string | undefined): ynab.API {
  if (!token) {
    console.error(
      "Missing YNAB_TOKEN. Create a .env file with YNAB_TOKEN=<your token> " +
        "and run with --env-file=.env (see package.json scripts).",
    );
    process.exit(1);
  }
  return new ynab.API(token);
}

// Turn whatever was thrown into a readable message. This exists because the YNAB
// SDK does NOT throw an Error on a non-2xx response — its runtime does
// `throw await response.json()`, so a 400 (bad id) or 429 (rate limit) throws
// the parsed JSON error BODY, a plain object. The MCP SDK then stringifies that
// to the useless "[object Object]". `ynab.instanceOfErrorResponse` is the SDK's
// own type guard for that body; we pull the human-readable name + detail out of
// it. Real network failures throw a genuine Error (FetchError) and fall through
// to the `e.message` branch, which is already fine.
export function ynabErrorText(e: unknown): string {
  // The SDK guard takes `object`, so narrow away null/primitives first.
  if (typeof e === "object" && e !== null && ynab.instanceOfErrorResponse(e)) {
    return `YNAB API error: ${e.error.name} — ${e.error.detail}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

// Boundary wrapper for every YNAB API call. On failure it re-throws a REAL Error
// carrying ynabErrorText's message. The MCP SDK already converts a thrown Error
// into `{ isError: true, content: [...] }` with `error.message` as the text (see
// its tool handler) — so wrapping the call is all it takes to turn
// "[object Object]" into an actionable message AND get the isError flag for free.
// (Non-Error throws are what we're fixing; this normalizes them.)
export async function ynabCall<T>(op: Promise<T>): Promise<T> {
  try {
    return await op;
  } catch (e) {
    throw new Error(ynabErrorText(e));
  }
}
