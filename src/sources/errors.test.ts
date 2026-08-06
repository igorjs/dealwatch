import { describe, expect, it } from "vitest";
import { SourceError } from "./errors";

describe("SourceError", () => {
  it("carries the source field and a message correctly", () => {
    // Arrange
    const source = "coles";
    const message = "non-2xx response: 403";

    // Act
    const error = new SourceError(source, message);

    // Assert
    expect(error.source).toBe(source);
    expect(error.message).toBe(`[${source}] ${message}`);
    expect(error.name).toBe("SourceError");
    expect(error).toBeInstanceOf(Error);
  });

  it("passes through ErrorOptions.cause", () => {
    // Arrange
    const cause = new SyntaxError("Unexpected token < in JSON at position 0");

    // Act
    const error = new SourceError("woolworths", "bad JSON body", { cause });

    // Assert
    expect(error.cause).toBe(cause);
  });
});
