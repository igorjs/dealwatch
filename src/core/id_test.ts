import { assertEquals, assertNotEquals } from "@std/assert";
import { canonicalUrl, stableId } from "./id.ts";

const URL_VARIANTS = [
  "https://x.com/a/?utm=1",
  "https://x.com/a#frag",
  "HTTPS://X.com:443/a",
  "https://x.com/a/",
];

Deno.test("canonicalUrl collapses query, fragment, default-port, and trailing-slash variants to the same value", () => {
  // Arrange
  const variants = URL_VARIANTS;

  // Act
  const canonicalized = variants.map(canonicalUrl);

  // Assert
  for (const value of canonicalized) {
    assertEquals(value, "https://x.com/a");
  }
});

Deno.test("canonicalUrl keeps a non-default port", () => {
  // Arrange
  const url = "https://x.com:8443/a";

  // Act
  const result = canonicalUrl(url);

  // Assert
  assertEquals(result, "https://x.com:8443/a");
});

Deno.test("stableId is equal for URL variants that canonicalize the same, under one source", () => {
  // Arrange
  const variants = URL_VARIANTS;

  // Act
  const ids = variants.map((url) => stableId("coles", url));

  // Assert
  for (const id of ids) {
    assertEquals(id, ids[0]);
  }
});

Deno.test("stableId differs for the same url under two different sources", () => {
  // Arrange
  const url = "https://x.com/a";

  // Act
  const colesId = stableId("coles", url);
  const aldiId = stableId("aldi", url);

  // Assert
  assertNotEquals(colesId, aldiId);
});
