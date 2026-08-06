/**
 * Posts `message` as the request body to an ntfy topic URL, triggering a push
 * notification. `fetchFn` is injected (defaults to the global `fetch`) so
 * tests never hit the network.
 *
 * Throws on a non-2xx response, with the status in the error message. A
 * `fetchFn` rejection (network error, timeout) propagates as-is.
 */
export async function push(
  message: string,
  topicUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchFn(topicUrl, {
    method: "POST",
    body: message,
  });
  if (!response.ok) {
    throw new Error(
      `ntfy push failed: ${response.status} ${response.statusText}`.trim(),
    );
  }
}
