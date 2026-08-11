import { describe, expect, it } from "vitest";
import { newPage, STEALTH_OPTIONS, type BrowserLike, type PageLike } from "./browser.ts";

describe("newPage", () => {
  it("returns the injected fake browser's page", async () => {
    // Arrange
    const fakePage: PageLike = {
      goto: async () => null,
      evaluate: async () => undefined,
      close: async () => {},
    };
    const fakeBrowser: BrowserLike = {
      newPage: async () => fakePage,
    };

    // Act
    const page = await newPage(fakeBrowser);

    // Assert
    expect(page).toBe(fakePage);
  });
});

describe("STEALTH_OPTIONS", () => {
  it("carries the spike values proven against Akamai and Imperva", () => {
    // Arrange
    const { launch, context } = STEALTH_OPTIONS;

    // Act
    // (STEALTH_OPTIONS is a plain constant, no action needed to produce it)

    // Assert
    expect(launch.args).toContain("--no-sandbox");
    expect(launch.args).toContain("--disable-blink-features=AutomationControlled");
    expect(context.locale).toBe("en-AU");
    expect(context.timezoneId).toBe("Australia/Sydney");
    expect(context.viewport).toEqual({ width: 1366, height: 900 });
    expect(context.userAgent).not.toContain("HeadlessChrome");
    expect(context.userAgent).toContain("Chrome/");
    expect(context.extraHTTPHeaders["accept-language"]).toContain("en-AU");
  });
});
