import { generateKeyPairSync } from "node:crypto";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const { privateKey } = generateKeyPairSync("ed25519");
  const appStoreKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Pin values that a developer's .dev.vars would otherwise override.
            APP_ORIGIN: "http://localhost:8787",
            EMAIL_PROVIDER: "console",
            DISABLE_RATE_LIMIT: "1",
            JWT_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
            BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789",
            CREEM_WEBHOOK_SECRET: "whsec_test",
            CREEM_PRODUCTS: JSON.stringify({ prod_plus_year: "plus_year", prod_pro_month: "pro_month", prod_credits_3000: "credits_3000" }),
            ADMIN_EMAILS: "admin@example.com",
            APPSTORE_ISSUER_ID: "test-issuer",
            APPSTORE_KEY_ID: "TESTKEY123",
            APPSTORE_PRIVATE_KEY: appStoreKey.export({ type: "pkcs8", format: "pem" }).toString(),
            AI_API_KEY: "test-ai-key",
            AI_API_BASE: "https://ai.test/v1",
            AI_MODEL: "test-model",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
