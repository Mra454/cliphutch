import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, beforeEach, vi } from "vitest";

beforeEach(async () => {
  await reset();
  const statements = env.TEST_SCHEMA.replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .map((statement) => env.DB.prepare(statement));
  await env.DB.batch(statements);
});

afterEach(() => {
  vi.restoreAllMocks();
});
