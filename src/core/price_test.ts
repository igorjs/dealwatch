import { assertEquals } from "@std/assert";
import { computeDiscountPercent, toCents } from "./price.ts";

Deno.test("toCents converts a whole-dollar number to integer cents", () => {
  // Arrange
  const value = 5;

  // Act
  const result = toCents(value);

  // Assert
  assertEquals(result, 500);
});

Deno.test("toCents converts a fractional-dollar numeric string to integer cents", () => {
  // Arrange
  const value = "5.50";

  // Act
  const result = toCents(value);

  // Assert
  assertEquals(result, 550);
});

Deno.test("toCents returns null for null", () => {
  // Arrange
  const value = null;

  // Act
  const result = toCents(value);

  // Assert
  assertEquals(result, null);
});

Deno.test("toCents returns null for a non-numeric string", () => {
  // Arrange
  const value = "abc";

  // Act
  const result = toCents(value);

  // Assert
  assertEquals(result, null);
});

Deno.test("toCents returns null for undefined", () => {
  // Arrange
  const value = undefined;

  // Act
  const result = toCents(value);

  // Assert
  assertEquals(result, null);
});

Deno.test("toCents returns null for NaN", () => {
  // Arrange
  const value = NaN;

  // Act
  const result = toCents(value);

  // Assert
  assertEquals(result, null);
});

Deno.test("toCents returns null for a value that is neither a number nor a string", () => {
  // Arrange
  const value = { dollars: 5 };

  // Act
  const result = toCents(value);

  // Assert
  assertEquals(result, null);
});

Deno.test("computeDiscountPercent computes a whole-percent discount", () => {
  // Arrange
  const priceCents = 500;
  const wasCents = 1000;

  // Act
  const result = computeDiscountPercent(priceCents, wasCents);

  // Assert
  assertEquals(result, 50);
});

Deno.test("computeDiscountPercent rounds to the nearest whole percent", () => {
  // Arrange
  const priceCents = 333;
  const wasCents = 1000;

  // Act
  const result = computeDiscountPercent(priceCents, wasCents);

  // Assert
  assertEquals(result, 67);
});

Deno.test("computeDiscountPercent returns null when wasCents is unknown", () => {
  // Arrange
  const priceCents = 500;
  const wasCents = null;

  // Act
  const result = computeDiscountPercent(priceCents, wasCents);

  // Assert
  assertEquals(result, null);
});

Deno.test("computeDiscountPercent returns null when priceCents is unknown", () => {
  // Arrange
  const priceCents = null;
  const wasCents = 1000;

  // Act
  const result = computeDiscountPercent(priceCents, wasCents);

  // Assert
  assertEquals(result, null);
});

Deno.test("computeDiscountPercent returns null when wasCents is zero (no divide-by-zero)", () => {
  // Arrange
  const priceCents = 500;
  const wasCents = 0;

  // Act
  const result = computeDiscountPercent(priceCents, wasCents);

  // Assert
  assertEquals(result, null);
});

Deno.test("computeDiscountPercent returns null when price increased (was < price)", () => {
  // Arrange
  const priceCents = 1000;
  const wasCents = 500;

  // Act
  const result = computeDiscountPercent(priceCents, wasCents);

  // Assert
  assertEquals(result, null);
});
