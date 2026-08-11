import { describe, expect, it } from "vitest";
import { SourceError } from "./errors.ts";

describe("fetcher project scaffold", () => {
  it("runs a trivial test under plain Node vitest", () => {
    expect(1 + 1).toBe(2);
  });
});

describe("SourceError", () => {
  it("carries its message and source", () => {
    const error = new SourceError("aldi", "request failed");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SourceError");
    expect(error.source).toBe("aldi");
    expect(error.message).toBe("[aldi] request failed");
  });
});
