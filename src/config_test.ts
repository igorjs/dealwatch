import { assertEquals, assertThrows } from "@std/assert";
import { loadConfig } from "./config.ts";

/** A minimal, valid config object shared across tests as a base to mutate. */
function validConfigJson(): string {
  return JSON.stringify({
    watchlist: [
      {
        term: "chicken breast",
        minDiscountPercent: 50,
        exclude: [],
      },
    ],
    sinks: {
      shoppingListPath: "./shopping-list.json",
      ntfy: {
        topicUrl: "https://ntfy.sh/dealwatch-alerts",
      },
    },
    stores: {
      aldi: {
        servicePoint: "G452",
        categoryKeys: ["1588161426952145"],
      },
      coles: {
        url: "https://coles.com.au",
        headers: {},
      },
      woolworths: {
        url: "https://woolworths.com.au",
        headers: {},
      },
    },
  });
}

Deno.test("loadConfig parses a valid config file into a typed Config", async () => {
  // Arrange
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, validConfigJson());

    // Act
    const config = loadConfig(path, {});

    // Assert
    assertEquals(config.watchlist.length, 1);
    assertEquals(config.watchlist[0].term, "chicken breast");
    assertEquals(
      config.sinks.ntfy.topicUrl,
      "https://ntfy.sh/dealwatch-alerts",
    );
    assertEquals(config.stores.aldi.servicePoint, "G452");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("loadConfig throws on malformed JSON (trailing comma)", async () => {
  // Arrange
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const malformed = validConfigJson().replace(/}\s*$/, ",}");
    await Deno.writeTextFile(path, malformed);

    // Act & Assert
    assertThrows(() => loadConfig(path, {}));
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("loadConfig throws when watchlist is empty", async () => {
  // Arrange
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const parsed = JSON.parse(validConfigJson());
    parsed.watchlist = [];
    await Deno.writeTextFile(path, JSON.stringify(parsed));

    // Act & Assert
    assertThrows(() => loadConfig(path, {}));
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("loadConfig throws when the ntfy topic is missing", async () => {
  // Arrange
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const parsed = JSON.parse(validConfigJson());
    delete parsed.sinks.ntfy.topicUrl;
    await Deno.writeTextFile(path, JSON.stringify(parsed));

    // Act & Assert
    assertThrows(() => loadConfig(path, {}));
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("loadConfig applies an env override for the ntfy topic over the file value", async () => {
  // Arrange
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, validConfigJson());

    // Act
    const config = loadConfig(path, {
      DEALWATCH_NTFY_TOPIC: "https://ntfy.sh/env-override-topic",
    });

    // Assert
    assertEquals(
      config.sinks.ntfy.topicUrl,
      "https://ntfy.sh/env-override-topic",
    );
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("loadConfig ignores an env override when the var is unset", async () => {
  // Arrange
  const path = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(path, validConfigJson());

    // Act
    const config = loadConfig(path, {});

    // Assert
    assertEquals(
      config.sinks.ntfy.topicUrl,
      "https://ntfy.sh/dealwatch-alerts",
    );
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("loadConfig throws a clear error when the file does not exist", () => {
  // Arrange
  const path = "./does-not-exist-dealwatch-config.json";

  // Act & Assert
  assertThrows(() => loadConfig(path, {}));
});

Deno.test("config.example.json parses cleanly through loadConfig", () => {
  // Arrange
  const path = new URL("../config.example.json", import.meta.url).pathname;

  // Act
  const config = loadConfig(path, {});

  // Assert
  assertEquals(config.watchlist.length >= 1, true);
});
