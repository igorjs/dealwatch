import { assertEquals } from "@std/assert";
import { toCategory } from "./category.ts";

Deno.test("a Woolworths department maps to its shared category", () => {
  // Arrange
  const fruitVeg = "Fruit & Veg";
  const meatSeafood = "Meat & Seafood";
  const bakery = "Bakery";

  // Act
  const fruitVegResult = toCategory("woolworths", fruitVeg);
  const meatSeafoodResult = toCategory("woolworths", meatSeafood);
  const bakeryResult = toCategory("woolworths", bakery);

  // Assert
  assertEquals(fruitVegResult, "fruit-veg");
  assertEquals(meatSeafoodResult, "meat-seafood");
  assertEquals(bakeryResult, "bakery");
});

Deno.test("a Coles department maps to its shared category", () => {
  // Arrange
  const meatSeafoodDeli = "Meat, Seafood & Deli";
  const dairyEggsFridge = "Dairy, Eggs & Fridge";

  // Act
  const meatSeafoodResult = toCategory("coles", meatSeafoodDeli);
  const dairyEggsResult = toCategory("coles", dairyEggsFridge);

  // Assert
  assertEquals(meatSeafoodResult, "meat-seafood");
  assertEquals(dairyEggsResult, "dairy-eggs");
});

Deno.test("an Aldi department maps to its shared category", () => {
  // Arrange
  const freshProduce = "Fresh Produce";
  const frozenFood = "Frozen Food";

  // Act
  const freshProduceResult = toCategory("aldi", freshProduce);
  const frozenFoodResult = toCategory("aldi", frozenFood);

  // Assert
  assertEquals(freshProduceResult, "fruit-veg");
  assertEquals(frozenFoodResult, "frozen");
});

Deno.test("an unmapped department string maps to other", () => {
  // Arrange
  const unknownDepartment = "Outdoor Furniture";

  // Act
  const result = toCategory("coles", unknownDepartment);

  // Assert
  assertEquals(result, "other");
});

Deno.test("a null department maps to other", () => {
  // Arrange
  const department = null;

  // Act
  const result = toCategory("woolworths", department);

  // Assert
  assertEquals(result, "other");
});

Deno.test("an empty department string maps to other", () => {
  // Arrange
  const department = "";

  // Act
  const result = toCategory("aldi", department);

  // Assert
  assertEquals(result, "other");
});

Deno.test("department matching is case-insensitive", () => {
  // Arrange
  const upper = "FRUIT & VEG";
  const lower = "fruit & veg";

  // Act
  const upperResult = toCategory("woolworths", upper);
  const lowerResult = toCategory("woolworths", lower);

  // Assert
  assertEquals(upperResult, "fruit-veg");
  assertEquals(lowerResult, "fruit-veg");
});

Deno.test("toCategory never throws, even on unusual input", () => {
  // Arrange
  const weirdInputs = ["   ", "🥑🥑🥑", "\n\t", "a".repeat(500)];

  // Act & Assert
  for (const input of weirdInputs) {
    const result = toCategory("coles", input);
    assertEquals(typeof result, "string");
  }
});
