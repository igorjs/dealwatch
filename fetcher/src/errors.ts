/**
 * Thrown by a source fetcher when a store request fails: a non-2xx response,
 * a non-JSON body (a bot-challenge HTML page), or an unparseable payload.
 * A typed error lets the pipeline isolate and back off a source without a raw
 * SyntaxError leaking from res.json().
 */
export class SourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[${source}] ${message}`, options);
    this.name = "SourceError";
  }
}
