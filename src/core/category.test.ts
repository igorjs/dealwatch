import { describe, expect, it } from "vitest";
import { toCategory } from "./category";
import type { Source } from "../types";

describe("toCategory", () => {
  it.each<[Source, string, string]>([
    ["woolworths", "Fruit & Veg", "fruit-veg"],
    ["woolworths", "Meat & Seafood", "meat-seafood"],
    ["woolworths", "Bakery", "bakery"],
    ["coles", "Meat, Seafood & Deli", "meat-seafood"],
    ["coles", "Dairy, Eggs & Fridge", "dairy-eggs"],
    ["aldi", "Fresh Produce", "fruit-veg"],
    ["aldi", "Frozen Food", "frozen"],
  ])(
    "maps %s department %j to shared category %j",
    (source, department, expected) => {
      // Arrange
      // (source, department, expected provided by the table)

      // Act
      const result = toCategory(source, department);

      // Assert
      expect(result).toBe(expected);
    },
  );

  it("maps an unmapped department string to other", () => {
    // Arrange
    const unknownDepartment = "Outdoor Furniture";

    // Act
    const result = toCategory("coles", unknownDepartment);

    // Assert
    expect(result).toBe("other");
  });

  it("maps a null department to other", () => {
    // Arrange
    const department = null;

    // Act
    const result = toCategory("woolworths", department);

    // Assert
    expect(result).toBe("other");
  });

  it("maps an empty department string to other", () => {
    // Arrange
    const department = "";

    // Act
    const result = toCategory("aldi", department);

    // Assert
    expect(result).toBe("other");
  });

  it("matches departments case-insensitively", () => {
    // Arrange
    const upper = "FRUIT & VEG";
    const lower = "fruit & veg";

    // Act
    const upperResult = toCategory("woolworths", upper);
    const lowerResult = toCategory("woolworths", lower);

    // Assert
    expect(upperResult).toBe("fruit-veg");
    expect(lowerResult).toBe("fruit-veg");
  });

  it("never throws, even on unusual input", () => {
    // Arrange
    const weirdInputs = ["   ", "🥑🥑🥑", "\n\t", "a".repeat(500)];

    // Act & Assert
    for (const input of weirdInputs) {
      const result = toCategory("coles", input);
      expect(typeof result).toBe("string");
    }
  });
});
