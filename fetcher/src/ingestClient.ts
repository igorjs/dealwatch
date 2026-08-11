import type { SourceResult } from "../../src/types.ts";

/**
 * The narrow shape of the global `fetch` this module calls: a URL string
 * and a plain init object, resolving to a response with `ok`/`status`.
 * Declared locally, not pulled from a "dom" lib, because
 * fetcher/tsconfig.json scopes `lib` to plain ES2022 and carries no such
 * ambient type. Node 18+ provides a real `fetch` at runtime regardless, and
 * it structurally satisfies this narrower shape.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number }>;

declare const fetch: FetchLike;

/** Where and how to authenticate an ingest POST. */
export interface IngestTarget {
  url: string;
  token: string;
}

/**
 * POSTs `{ results }` as JSON to the Worker's ingest endpoint, authenticated
 * with a bearer token. `fetchFn` is injected (defaults to the global
 * `fetch`) so tests never hit the network.
 *
 * Throws on a non-2xx response, with the status and the URL in the error
 * message but never the token: this runs as a GitHub Actions job on a
 * public repo, so anything printed in the run log is world readable. The
 * token only ever goes in the Authorization header, never in the message,
 * a log line, or the URL. A `fetchFn` rejection (network error, timeout)
 * propagates as-is.
 */
export async function postIngest(
  results: SourceResult[],
  { url, token }: IngestTarget,
  fetchFn: FetchLike = fetch,
): Promise<void> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ results }),
  });
  if (!response.ok) {
    throw new Error(
      `ingest POST to ${url} failed with status ${response.status}`,
    );
  }
}
