import { readFile } from "node:fs/promises";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TEST_SCHEMA: await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
          TEST_SCHEMA_BASE: await readFile(
            new URL("./schema.base.sql", import.meta.url),
            "utf8",
          ),
          TEST_MIGRATION_0001: await readFile(
            new URL("./migrations/0001_add_product_to_licenses.sql", import.meta.url),
            "utf8",
          ),
          TEST_MIGRATION_0002: await readFile(
            new URL("./migrations/0002_add_license_email_sent_at.sql", import.meta.url),
            "utf8",
          ),
          TEST_MIGRATION_0003: await readFile(
            new URL("./migrations/0003_add_mutation_journal.sql", import.meta.url),
            "utf8",
          ),
          TEST_MIGRATION_0004: await readFile(
            new URL("./migrations/0004_add_refund_event_expiry.sql", import.meta.url),
            "utf8",
          ),
          ENVIRONMENT: "test",
          STRIPE_SECRET_KEY: "sk_test_worker_fixture",
          STRIPE_WEBHOOK_SECRET: "whsec_worker_fixture",
          RESEND_API_KEY: "re_worker_fixture",
          RESEND_FROM_EMAIL: "ClipHutch <licenses@cliphutch.example>",
          OUTBOUND_TIMEOUT_MS: "25",
          MUTATION_JOURNAL_RETENTION_DAYS: "90",
          REFUND_EVENT_RETENTION_DAYS: "365",
          CLIPHUTCH_ALLOWED_ORIGINS:
            "chrome-extension://pdpcameeghhppjbhecolnhdepceeldhl",
          COMPUTEDKIT_ALLOWED_ORIGINS:
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          CHECKOUT_ALLOWED_ORIGINS: "https://cliphutch.com",
          CLIPHUTCH_STRIPE_PAYMENT_LINK_ID: "plink_cliphutch_fixture",
          COMPUTEDKIT_STRIPE_PRICE_ID: "price_computedkit_fixture",
          COMPUTEDKIT_SUCCESS_URL: "https://cliphutch.example/computedkit/thanks/",
          COMPUTEDKIT_CANCEL_URL: "https://cliphutch.example/computedkit/",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    testTimeout: 10_000,
  },
});
