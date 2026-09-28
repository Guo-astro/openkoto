import { openAiCompatibleChat, UsageMeter, type ChatFn } from "@openkoto/core";
import type { Env } from "../env";
import { reserveCredits, settleCredits } from "../billing/credits";
import { ApiError } from "../lib/http";
import { newId, sha256Hex } from "../lib/crypto";

// 1 credit = ¥0.01. Credits are priced at ~2× the model cost (docs/plans/…design.md §3.7).
const CNY_PER_USD = 7.2;
const CREDITS_PER_CNY = 100;
const MARKUP = 2;

export interface ModelPricing {
  inputUsdPerM: number;
  outputUsdPerM: number;
}

// Defaults: DeepSeek flash, peak rates (2026-09).
const DEFAULT_PRICING: ModelPricing = { inputUsdPerM: 0.3, outputUsdPerM: 1.2 };

export function creditsFor(inputTokens: number, outputTokens: number, pricing: ModelPricing = DEFAULT_PRICING): number {
  const usd = (inputTokens * pricing.inputUsdPerM + outputTokens * pricing.outputUsdPerM) / 1_000_000;
  return Math.max(1, Math.ceil(usd * CNY_PER_USD * CREDITS_PER_CNY * MARKUP));
}

/** Rough token estimate for reservations: CJK ≈ 1 token/char, Latin ≈ 1 token/4 chars. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[぀-ヿ㐀-鿿가-힯]/.test(ch)) cjk += 1;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export function hostedChat(env: Env): ChatFn {
  if (!env.AI_API_KEY) throw new ApiError(503, "AI_UNAVAILABLE", "hosted AI is not configured");
  return openAiCompatibleChat({
    baseUrl: env.AI_API_BASE ?? "https://api.deepseek.com/v1",
    apiKey: env.AI_API_KEY,
    model: env.AI_MODEL ?? "deepseek-chat",
    fetch: (url, init) => fetch(url, init),
  });
}

export interface MeteredOptions {
  userId: string;
  feature: string;
  keyId?: string;
  /** Upper bound on tokens this call may use (prompt + expected output). */
  estimateInput: number;
  estimateOutput: number;
}

/**
 * Runs an AI task under a credit reservation: reserve the estimate, run, then settle to the
 * actual usage (refunding the rest). Throws 402 when the balance can't cover the estimate.
 */
export async function metered<T>(env: Env, opts: MeteredOptions, run: (chat: ChatFn) => Promise<T>): Promise<{ result: T; credits: number }> {
  const requestId = newId();
  const reserved = creditsFor(opts.estimateInput, opts.estimateOutput);
  if (!(await reserveCredits(env, opts.userId, reserved, requestId))) {
    throw new ApiError(402, "INSUFFICIENT_CREDITS", "not enough credits");
  }
  const meter = new UsageMeter();
  const model = env.AI_MODEL ?? "deepseek-chat";
  let settled = false;
  try {
    const result = await run(meter.wrap(hostedChat(env)));
    const actual = creditsFor(meter.inputTokens, meter.outputTokens);
    await settleCredits(env, opts.userId, reserved, actual, requestId);
    settled = true;
    await recordUsage(env, { requestId, userId: opts.userId, feature: opts.feature, keyId: opts.keyId, model, meter, credits: actual, status: "ok" }).catch(() => {});
    return { result, credits: actual };
  } catch (err) {
    // Charge only for tokens the provider actually consumed; settle exactly once.
    const actual = meter.calls ? creditsFor(meter.inputTokens, meter.outputTokens) : 0;
    if (!settled) await settleCredits(env, opts.userId, reserved, actual, requestId);
    await recordUsage(env, { requestId, userId: opts.userId, feature: opts.feature, keyId: opts.keyId, model, meter, credits: actual, status: "error" }).catch(() => {});
    if (err instanceof ApiError) throw err;
    console.error("ai task failed", opts.feature, err);
    throw new ApiError(502, "AI_ERROR", "the AI provider failed, please retry");
  }
}

async function recordUsage(
  env: Env,
  u: { requestId: string; userId: string; feature: string; keyId?: string; model: string; meter: UsageMeter; credits: number; status: string },
): Promise<void> {
  await env.DB.prepare(
    "insert into usage_records (request_id, user_id, feature, key_id, model, input_tokens, output_tokens, credits, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(u.requestId, u.userId, u.feature, u.keyId ?? null, u.model, u.meter.inputTokens, u.meter.outputTokens, u.credits, u.status, Date.now())
    .run();
}

// ---- response cache (identical requests are free) ---------------------------

export async function cacheKey(parts: unknown[]): Promise<string> {
  return `https://ai-cache.openkoto.internal/${await sha256Hex(JSON.stringify(parts))}`;
}

export async function cached<T>(key: string): Promise<T | null> {
  const hit = await caches.default.match(key);
  return hit ? ((await hit.json()) as T) : null;
}

export async function store(key: string, value: unknown, ttlSeconds = 30 * 24 * 3600): Promise<void> {
  await caches.default.put(key, new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttlSeconds}` } }));
}
