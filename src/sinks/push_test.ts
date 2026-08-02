import { assertEquals, assertRejects } from "@std/assert";
import { push } from "./push.ts";

const TOPIC_URL = "https://ntfy.sh/dealwatch-test-topic";

Deno.test("push: on 200, resolves and posts the message to the topic URL", async () => {
  // Arrange
  const calls: { input: unknown; init: RequestInit | undefined }[] = [];
  const fetchFn: typeof fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(new Response(null, { status: 200 }));
  };

  // Act
  await push("olive oil 50% off at Coles", TOPIC_URL, fetchFn);

  // Assert
  assertEquals(calls.length, 1);
  assertEquals(calls[0].input, TOPIC_URL);
  assertEquals(calls[0].init?.method, "POST");
  assertEquals(calls[0].init?.body, "olive oil 50% off at Coles");
});

Deno.test("push: 201 and 204 also resolve (any 2xx succeeds)", async () => {
  for (const status of [201, 204]) {
    // Arrange
    const fetchFn: typeof fetch = () =>
      Promise.resolve(new Response(null, { status }));

    // Act
    const result = await push("msg", TOPIC_URL, fetchFn);

    // Assert
    assertEquals(result, undefined);
  }
});

Deno.test("push: throws on every non-2xx status, with the status in the error", async () => {
  for (const status of [400, 401, 403, 429, 500, 503]) {
    // Arrange
    const fetchFn: typeof fetch = () =>
      Promise.resolve(new Response(null, { status }));

    // Act + Assert
    await assertRejects(
      () => push("msg", TOPIC_URL, fetchFn),
      Error,
      String(status),
    );
  }
});

Deno.test("push: a rejecting fetchFn (network/timeout) propagates", async () => {
  // Arrange
  const fetchFn: typeof fetch = () =>
    Promise.reject(new Error("network timeout"));

  // Act + Assert
  await assertRejects(
    () => push("msg", TOPIC_URL, fetchFn),
    Error,
    "network timeout",
  );
});
