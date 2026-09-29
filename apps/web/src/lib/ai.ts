import {
  explainSentence,
  openAiCompatibleChat,
  translateChapterItems,
  translateLyricsLines,
  type ChatFn,
  type SegmentExplanation,
} from "@openkoto/core";
import { request } from "./api";

// Two ways to run AI on the web: the hosted OpenKoto AI (credits) or the user's own
// OpenAI-compatible key (BYOK), kept only in this browser.

const BYOK_KEY = "openkoto.byok";

export interface ByokConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function loadByok(): ByokConfig | null {
  try {
    const raw = localStorage.getItem(BYOK_KEY);
    return raw ? (JSON.parse(raw) as ByokConfig) : null;
  } catch {
    return null;
  }
}

export function saveByok(config: ByokConfig | null): void {
  try {
    if (config) localStorage.setItem(BYOK_KEY, JSON.stringify(config));
    else localStorage.removeItem(BYOK_KEY);
  } catch {
    // Storage unavailable: BYOK just won't persist.
  }
}

export type AiMode = "hosted" | "byok";

function byokChat(): ChatFn {
  const config = loadByok();
  if (!config) throw new Error("BYOK is not configured");
  return openAiCompatibleChat({ ...config, fetch: (url, init) => fetch(url, init) });
}

export interface AiEngine {
  mode: AiMode;
  translateLyrics(lines: string[], targetLanguage: string, meta?: { title?: string; artist?: string }): Promise<string[]>;
  translateItems(items: { id: string; text: string }[], targetLanguage: string, meta?: { bookTitle?: string; chapterTitle?: string }): Promise<Map<string, string>>;
  explain(text: string, targetLanguage: string): Promise<SegmentExplanation>;
}

const HOSTED_CHAPTER_BATCH = 120;

export function aiEngine(mode: AiMode): AiEngine {
  if (mode === "byok") {
    return {
      mode,
      async translateLyrics(lines, targetLanguage, meta) {
        return (await translateLyricsLines(byokChat(), { lines, targetLanguage, ...meta })).translations;
      },
      translateItems: (items, targetLanguage, meta) => translateChapterItems(byokChat(), items, { targetLanguage, ...meta }),
      explain: (text, targetLanguage) => explainSentence(byokChat(), text, targetLanguage),
    };
  }
  return {
    mode,
    async translateLyrics(lines, targetLanguage, meta) {
      const res = await request<{ translations: string[] }>("/api/v1/ai/translate-lyrics", {
        method: "POST",
        body: JSON.stringify({ lines, targetLanguage, ...meta }),
      });
      return res.translations;
    },
    async translateItems(items, targetLanguage, meta) {
      const out = new Map<string, string>();
      for (let i = 0; i < items.length; i += HOSTED_CHAPTER_BATCH) {
        const res = await request<{ translations: Record<string, string> }>("/api/v1/ai/translate-chapter", {
          method: "POST",
          body: JSON.stringify({ items: items.slice(i, i + HOSTED_CHAPTER_BATCH), targetLanguage, ...meta }),
        });
        for (const [id, t] of Object.entries(res.translations)) out.set(id, t);
      }
      return out;
    },
    async explain(text, targetLanguage) {
      return (await request<{ explanation: SegmentExplanation }>("/api/v1/ai/explain", { method: "POST", body: JSON.stringify({ text, targetLanguage }) })).explanation;
    },
  };
}

const TARGET_KEY = "openkoto.targetLanguage";

export function targetLanguage(): string {
  try {
    return localStorage.getItem(TARGET_KEY) ?? (navigator.language.startsWith("zh") ? "zh-CN" : navigator.language.startsWith("ja") ? "ja" : "en");
  } catch {
    return "zh-CN";
  }
}

export function setTargetLanguage(lang: string): void {
  try {
    localStorage.setItem(TARGET_KEY, lang);
  } catch {
    // ignore
  }
}
