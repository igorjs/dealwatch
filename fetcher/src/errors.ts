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

/**
 * The failure every driver raises when a store answers with a valid, empty
 * response instead of an HTTP error. A datacenter runner IP can be soft
 * bot-blocked that way, and recording it as a healthy fetch would hide the
 * store until someone noticed the deals had stopped.
 *
 * Shared rather than written out per driver because this text reaches the
 * operator's ntfy alert, so all three sources should read identically.
 */
export function zeroDealSoftBlock(source: string): SourceError {
  return new SourceError(source, `${source} returned 0 deals (possible soft bot-block)`);
}
