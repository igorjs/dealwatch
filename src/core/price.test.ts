import { describe, expect, it } from "vitest";
import { computeDiscountPercent, toCents } from "./price";

describe("toCents", () => {
  it("converts a whole-dollar number to integer cents", () => {
    // Arrange
    const value = 5;

    // Act
    const result = toCents(value);

    // Assert
    expect(result).toBe(500);
  });

  it("converts a fractional-dollar numeric string to integer cents", () => {
    // Arrange
    const value = "5.50";

    // Act
    const result = toCents(value);

    // Assert
    expect(result).toBe(550);
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["a non-numeric string", "abc"],
    ["undefined", undefined],
    ["NaN", NaN],
    ["a value that is neither a number nor a string", { dollars: 5 }],
  ])("returns null for %s", (_description, value) => {
    // Arrange
    // (value provided by the table)

    // Act
    const result = toCents(value);

    // Assert
    expect(result).toBe(null);
  });
});

describe("computeDiscountPercent", () => {
  it("computes a whole-percent discount", () => {
    // Arrange
    const priceCents = 500;
    const wasCents = 1000;

    // Act
    const result = computeDiscountPercent(priceCents, wasCents);

    // Assert
    expect(result).toBe(50);
  });

  it("rounds to the nearest whole percent", () => {
    // Arrange
    const priceCents = 333;
    const wasCents = 1000;

    // Act
    const result = computeDiscountPercent(priceCents, wasCents);

    // Assert
    expect(result).toBe(67);
  });

  it("returns null when wasCents is unknown", () => {
    // Arrange
    const priceCents = 500;
    const wasCents = null;

    // Act
    const result = computeDiscountPercent(priceCents, wasCents);

    // Assert
    expect(result).toBe(null);
  });

  it("returns null when priceCents is unknown", () => {
    // Arrange
    const priceCents = null;
    const wasCents = 1000;

    // Act
    const result = computeDiscountPercent(priceCents, wasCents);

    // Assert
    expect(result).toBe(null);
  });

  it("returns null when wasCents is zero (no divide-by-zero)", () => {
    // Arrange
    const priceCents = 500;
    const wasCents = 0;

    // Act
    const result = computeDiscountPercent(priceCents, wasCents);

    // Assert
    expect(result).toBe(null);
  });

  it("returns null when price increased (was < price)", () => {
    // Arrange
    const priceCents = 1000;
    const wasCents = 500;

    // Act
    const result = computeDiscountPercent(priceCents, wasCents);

    // Assert
    expect(result).toBe(null);
  });
});
