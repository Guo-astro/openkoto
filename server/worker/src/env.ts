import type { UserVault } from "./sync/vault";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  VAULT: DurableObjectNamespace<UserVault>;
  JOBS: Queue<JobMessage>;
  ASSETS?: Fetcher;
  /** Per-IP limits for sign-in endpoints (optional so tests / local dev can omit them). */
  AUTH_LIMITER?: RateLimit;
  OTP_LIMITER?: RateLimit;
  /** "1" disables the limiters (integration tests share one client IP). */
  DISABLE_RATE_LIMIT?: string;

  APP_ORIGIN: string;
  APP_NAME: string;
  /** "resend" | "console" */
  EMAIL_PROVIDER: string;
  EMAIL_FROM: string;
  APPLE_APP_BUNDLE_ID: string;

  // Secrets (wrangler secret put …)
  BETTER_AUTH_SECRET: string;
  /** Ed25519 private key, PKCS8 PEM. See scripts/gen-jwt-key.mjs */
  JWT_PRIVATE_KEY: string;
  RESEND_API_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APPLE_CLIENT_ID?: string;
  APPLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  CREEM_API_KEY?: string;
  CREEM_WEBHOOK_SECRET?: string;
  CREEM_API_BASE?: string;
  /** JSON map of Creem product id → { plan, durationDays?, credits? } */
  CREEM_PRODUCTS?: string;
  APPSTORE_ENVIRONMENT?: string;
  /** App Store Connect API key (In-App Purchase key) used to query the App Store Server API. */
  APPSTORE_ISSUER_ID?: string;
  APPSTORE_KEY_ID?: string;
  APPSTORE_PRIVATE_KEY?: string;
  /** JSON map of App Store product id → { plan, credits? } */
  APPSTORE_PRODUCTS?: string;
  /** Comma separated emails allowed to use /api/admin */
  ADMIN_EMAILS?: string;
  AI_API_BASE?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
}

export type JobMessage = { kind: "translate_book"; jobId: string; userId: string } | { kind: "delete_account"; userId: string };

export interface Principal {
  userId: string;
  email: string;
  /** Device the token was issued to; null for cookie sessions and API keys. */
  deviceId: string | null;
  scopes: string[];
  via: "session" | "jwt" | "api_key";
  keyId?: string;
}

export type AppBindings = { Bindings: Env; Variables: { principal: Principal } };
