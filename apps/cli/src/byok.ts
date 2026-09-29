// Bring-your-own-key lyrics translation: runs locally against any OpenAI-compatible
// /chat/completions endpoint using the shared prompt from @openkoto/core.

import { lineAlignmentRetryMessage, parseLineTranslations, translateLyricsPrompt } from "@openkoto/core";
import type { FetchLike } from "@openkoto/client";
import type { ByokConfig } from "./config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class ByokError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ByokError";
  }
}

export function requireByok(config: ByokConfig | undefined): Required<ByokConfig> {
  const missing = (["base_url", "api_key", "model"] as const).filter((k) => !config?.[k]);
  if (missing.length) {
    throw new ByokError(
      `BYOK provider is not configured (missing ${missing.join(", ")}). Set it with:\n` +
        "  koto config set byok.base_url https://api.openai.com/v1\n" +
        "  koto config set byok.api_key sk-...\n" +
        "  koto config set byok.model gpt-4o-mini",
    );
  }
  return config as Required<ByokConfig>;
}

export async function chatCompletion(cfg: Required<ByokConfig>, messages: ChatMessage[], temperature: number, fetchImpl: FetchLike): Promise<string> {
  const url = `${cfg.base_url.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.api_key}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature }),
  });
  const text = await res.text();
  if (!res.ok) throw new ByokError(`BYOK provider returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  let data: { choices?: { message?: { content?: string } }[] };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    throw new ByokError("BYOK provider returned a non-JSON response");
  }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new ByokError("BYOK provider response has no message content");
  return content;
}

export interface TranslateLyricsResult {
  translations: string[];
  aligned: boolean;
  attempts: number;
}

/** Whole-song translation; re-prompts once when the reply is not line-aligned. */
export async function translateLyricsByok(
  input: { lines: string[]; targetLanguage: string; title?: string; artist?: string },
  cfg: Required<ByokConfig>,
  fetchImpl: FetchLike,
): Promise<TranslateLyricsResult> {
  const prompt = translateLyricsPrompt(input);
  const messages: ChatMessage[] = [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
  const temperature = prompt.temperature ?? 0.3;
  const first = await chatCompletion(cfg, messages, temperature, fetchImpl);
  let parsed = safeParse(first, input.lines.length);
  if (parsed.aligned) return { ...parsed, attempts: 1 };

  const received = parsed.received;
  messages.push({ role: "assistant", content: first }, { role: "user", content: lineAlignmentRetryMessage(input.lines.length, received) });
  const second = await chatCompletion(cfg, messages, temperature, fetchImpl);
  const retry = safeParse(second, input.lines.length);
  // Keep whichever answer covered more lines.
  if (retry.aligned || retry.filled >= parsed.filled) parsed = retry;
  return { translations: parsed.translations, aligned: parsed.aligned, attempts: 2 };
}

function safeParse(content: string, expected: number): { translations: string[]; aligned: boolean; received: number; filled: number } {
  try {
    const { translations, aligned } = parseLineTranslations(content, expected);
    let received = 0;
    try {
      const arr = JSON.parse(content.trim().replace(/^```(?:json)?|```$/g, "")) as unknown;
      received = Array.isArray(arr) ? arr.length : 0;
    } catch {
      received = translations.filter(Boolean).length;
    }
    return { translations, aligned, received, filled: translations.filter(Boolean).length };
  } catch {
    return { translations: Array.from({ length: expected }, () => ""), aligned: false, received: 0, filled: 0 };
  }
}
