// Provider-agnostic AI task runners shared by the web app (BYOK), the server (hosted AI)
// and the CLI. They build prompts from ./prompts and parse the replies with ./llm-json.

import { parseSegmentExplanation, parseWordGloss } from "./llm-json";
import type { SegmentExplanation, VocabularyItem } from "./models";
import {
  CHAPTER_BATCH_SIZE,
  explainPrompt,
  lineAlignmentRetryMessage,
  parseBatchTranslations,
  parseLineTranslations,
  translateChapterPrompt,
  translateLyricsPrompt,
  translatePrompt,
  wordGlossPrompt,
  type PromptMessages,
} from "./prompts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  content: string;
  usage?: ChatUsage;
}

export type ChatFn = (messages: ChatMessage[], opts?: { temperature?: number; json?: boolean }) => Promise<ChatResult>;

function toMessages(prompt: PromptMessages): ChatMessage[] {
  return [
    { role: "system", content: prompt.system },
    { role: "user", content: prompt.user },
  ];
}

/** Adds up token usage across the calls a task makes. */
export class UsageMeter {
  inputTokens = 0;
  outputTokens = 0;
  calls = 0;

  wrap(chat: ChatFn): ChatFn {
    return async (messages, opts) => {
      const result = await chat(messages, opts);
      this.calls += 1;
      this.inputTokens += result.usage?.inputTokens ?? 0;
      this.outputTokens += result.usage?.outputTokens ?? 0;
      return result;
    };
  }
}

/** Minimal fetch signature so core stays free of DOM typings. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: FetchLike;
  headers?: Record<string, string>;
}

/** Chat function for any OpenAI-compatible /chat/completions endpoint (OpenAI, DeepSeek, OpenRouter, Kimi…). */
export function openAiCompatibleChat(config: OpenAiCompatibleConfig): ChatFn {
  const doFetch = config.fetch ?? ((globalThis as unknown as { fetch: FetchLike }).fetch);
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return async (messages, opts) => {
    const res = await doFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", ...config.headers },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: opts?.temperature ?? 0.3,
        stream: false,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AI provider error ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      content: body.choices?.[0]?.message?.content ?? "",
      usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 },
    };
  };
}

export async function translateText(chat: ChatFn, text: string, targetLanguage: string): Promise<string> {
  const prompt = translatePrompt(text, targetLanguage);
  return (await chat(toMessages(prompt), { temperature: prompt.temperature })).content.trim();
}

export async function explainSentence(chat: ChatFn, text: string, targetLanguage: string): Promise<SegmentExplanation> {
  const prompt = explainPrompt(text, targetLanguage);
  const result = await chat(toMessages(prompt), { temperature: prompt.temperature, json: true });
  return parseSegmentExplanation(result.content);
}

export async function glossWord(chat: ChatFn, word: string, sentence: string, targetLanguage: string): Promise<VocabularyItem> {
  const prompt = wordGlossPrompt(word, sentence, targetLanguage);
  const result = await chat(toMessages(prompt), { temperature: prompt.temperature, json: true });
  return parseWordGloss(result.content);
}

export interface LyricsTranslationInput {
  lines: string[];
  targetLanguage: string;
  title?: string;
  artist?: string;
}

/** Whole-song translation, one output per input line; retries once if the line count drifts. */
export async function translateLyricsLines(chat: ChatFn, input: LyricsTranslationInput): Promise<{ translations: string[]; aligned: boolean }> {
  const prompt = translateLyricsPrompt(input);
  const messages = toMessages(prompt);
  const first = await chat(messages, { temperature: prompt.temperature, json: true });
  const parsed = parseLineTranslations(first.content, input.lines.length);
  if (parsed.aligned) return parsed;
  const retry = await chat(
    [
      ...messages,
      { role: "assistant", content: first.content },
      { role: "user", content: lineAlignmentRetryMessage(input.lines.length, parsed.translations.filter(Boolean).length) },
    ],
    { temperature: prompt.temperature, json: true },
  );
  const second = parseLineTranslations(retry.content, input.lines.length);
  return second.aligned ? second : { translations: parsed.translations.map((t, i) => t || second.translations[i] || ""), aligned: false };
}

export interface ChapterTranslationItem {
  id: string;
  text: string;
}

/** Translates sentences in batches of CHAPTER_BATCH_SIZE; returns id → translation. */
export async function translateChapterItems(
  chat: ChatFn,
  items: ChapterTranslationItem[],
  opts: { targetLanguage: string; bookTitle?: string; chapterTitle?: string; onProgress?: (done: number, total: number) => void },
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < items.length; i += CHAPTER_BATCH_SIZE) {
    const batch = items.slice(i, i + CHAPTER_BATCH_SIZE);
    const prompt = translateChapterPrompt({ items: batch, targetLanguage: opts.targetLanguage, bookTitle: opts.bookTitle, chapterTitle: opts.chapterTitle });
    const result = await chat(toMessages(prompt), { temperature: prompt.temperature, json: true });
    for (const { id, translation } of parseBatchTranslations(result.content)) {
      if (batch.some((b) => b.id === id) && translation) out.set(id, translation);
    }
    opts.onProgress?.(Math.min(i + batch.length, items.length), items.length);
  }
  return out;
}
