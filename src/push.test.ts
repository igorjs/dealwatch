import { describe, expect, it } from "vitest";
import { push } from "./push";

const TOPIC_URL = "https://ntfy.sh/dealwatch-test-topic";

describe("push", () => {
  it("on 200, resolves and posts the message to the topic URL", async () => {
    // Arrange
    const calls: { input: unknown; init: RequestInit | undefined }[] = [];
    const fetchFn: typeof fetch = (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(new Response(null, { status: 200 }));
    };

    // Act
    await push("olive oil 50% off at Coles", TOPIC_URL, fetchFn);

    // Assert
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.input).toBe(TOPIC_URL);
    expect(call?.init?.method).toBe("POST");
    expect(call?.init?.body).toBe("olive oil 50% off at Coles");
  });

  it("201 and 204 also resolve (any 2xx succeeds)", async () => {
    for (const status of [201, 204]) {
      // Arrange
      const fetchFn: typeof fetch = () =>
        Promise.resolve(new Response(null, { status }));

      // Act
      const result = await push("msg", TOPIC_URL, fetchFn);

      // Assert
      expect(result).toBeUndefined();
    }
  });

  it("throws on every non-2xx status, with the status in the error", async () => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      // Arrange
      const fetchFn: typeof fetch = () =>
        Promise.resolve(new Response(null, { status }));

      // Act + Assert
      await expect(push("msg", TOPIC_URL, fetchFn)).rejects.toThrow(
        String(status),
      );
    }
  });

  it("a rejecting fetchFn (network/timeout) propagates", async () => {
    // Arrange
    const fetchFn: typeof fetch = () =>
      Promise.reject(new Error("network timeout"));

    // Act + Assert
    await expect(push("msg", TOPIC_URL, fetchFn)).rejects.toThrow(
      "network timeout",
    );
  });
});
