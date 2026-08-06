import { describe, expect, it } from "vitest";
import { canonicalUrl, stableId } from "./id";

const URL_VARIANTS = [
  "https://x.com/a/?utm=1",
  "https://x.com/a#frag",
  "HTTPS://X.com:443/a",
  "https://x.com/a/",
];

describe("canonicalUrl", () => {
  it.each(URL_VARIANTS)(
    "collapses query, fragment, default-port, and trailing-slash variant %s to the same value",
    (variant) => {
      // Arrange
      const url = variant;

      // Act
      const result = canonicalUrl(url);

      // Assert
      expect(result).toBe("https://x.com/a");
    },
  );

  it("keeps a non-default port", () => {
    // Arrange
    const url = "https://x.com:8443/a";

    // Act
    const result = canonicalUrl(url);

    // Assert
    expect(result).toBe("https://x.com:8443/a");
  });
});

describe("stableId", () => {
  it("is equal for URL variants that canonicalize the same, under one source", () => {
    // Arrange
    const variants = URL_VARIANTS;

    // Act
    const ids = variants.map((url) => stableId("coles", url));

    // Assert
    for (const id of ids) {
      expect(id).toBe(ids[0]);
    }
  });

  it("differs for the same url under two different sources", () => {
    // Arrange
    const url = "https://x.com/a";

    // Act
    const colesId = stableId("coles", url);
    const aldiId = stableId("aldi", url);

    // Assert
    expect(colesId).not.toBe(aldiId);
  });
});
