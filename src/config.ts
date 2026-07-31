import { type Config, ConfigSchema } from "./types.ts";

/**
 * Reads the config file at `path`, applies env overrides for secrets, then
 * parses with `ConfigSchema`. Throws on a missing file, malformed JSON, or a
 * schema violation.
 *
 * `env` defaults to `Deno.env.toObject()` so production runs pick up real
 * process env, but tests must always pass an explicit `env` object — reading
 * real process env in a test breaks determinism (Assumption 15/testing
 * strategy: no test reads real process env).
 */
export function loadConfig(
  path: string,
  env: Record<string, string> = Deno.env.toObject(),
): Config {
  const raw = Deno.readTextFileSync(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Config file at "${path}" is not valid JSON`, { cause });
  }

  const withOverrides = applyEnvOverrides(parsed, env);

  const result = ConfigSchema.safeParse(withOverrides);
  if (!result.success) {
    throw new Error(
      `Config file at "${path}" failed validation: ${result.error.message}`,
    );
  }

  return result.data;
}

/**
 * Applies env overrides for secrets on top of the raw parsed JSON, before
 * schema validation. Only overrides fields that are actually set in `env` so
 * an unset var never clobbers a value from the file with `undefined`.
 */
function applyEnvOverrides(
  parsed: unknown,
  env: Record<string, string>,
): unknown {
  const ntfyTopic = env.DEALWATCH_NTFY_TOPIC;
  if (ntfyTopic === undefined) {
    return parsed;
  }

  const config = parsed as {
    sinks?: { ntfy?: Record<string, unknown> };
  };

  return {
    ...config,
    sinks: {
      ...config?.sinks,
      ntfy: {
        ...config?.sinks?.ntfy,
        topicUrl: ntfyTopic,
      },
    },
  };
}
