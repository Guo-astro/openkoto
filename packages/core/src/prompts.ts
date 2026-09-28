// Versioned prompt library. Ported from iOS OKAIClient/PromptLibrary.swift (itself aligned
// with desktop ai_service.rs), plus the web-first `translateLyrics` and `translateChapter` tasks.
// Changing a prompt's wording or output schema = bump its version.

import { parseLlmJson } from "./llm-json";

export const PROMPT_VERSION = {
  explain: "explain-v1",
  translate: "translate-v1",
  wordGloss: "gloss-v1",
  webClean: "webclean-v1",
  translateLyrics: "lyrics-translate-v1",
  translateChapter: "chapter-translate-v1",
} as const;

export type PromptTask = keyof typeof PROMPT_VERSION;

export interface PromptMessages {
  task: PromptTask;
  version: string;
  system: string;
  user: string;
  /** Sampling temperature the clients use for this task. */
  temperature?: number;
}

/** Target-language code → name used inside prompts (unknown codes fall back to 中文). */
export function nativeLanguageName(targetLanguage: string): string {
  switch (targetLanguage) {
    case "zh":
    case "zh-CN":
      return "中文";
    case "zh-TW":
      return "繁體中文";
    case "en":
      return "English";
    case "ja":
      return "Japanese";
    case "ko":
      return "Korean";
    case "es":
      return "Español";
    case "fr":
      return "Français";
    case "de":
      return "Deutsch";
    case "ru":
      return "Русский";
    case "ar":
      return "العربية";
    default:
      return "中文";
  }
}

// MARK: - explain

export function explainSystemPrompt(text: string, targetLanguage: string): string {
  const lang = nativeLanguageName(targetLanguage);
  return `You are a professional language learning assistant. The user's native language is ${lang}. Please analyze the following text segment comprehensively and return the result strictly in the following JSON format. Do NOT add any extra explanations or markdown formatting outside the JSON block.

User's Native Language: ${lang}

Text to Analyze:
---
${text}
---

Please strictly adhere to this JSON structure (all keys must be in English):
{
  "translation": "Translate the text into natural, fluent ${lang}",
  "explanation": "Explain the text in ${lang}, covering context, tone, and cultural background. Use Markdown formatting.",
  "vocabulary": [
    {
      "word": "The word or phrase from the text",
      "reading": "Pronunciation/Reading (e.g., Hiragana for Japanese, IPA for English)",
      "meaning": "Core meaning in the context, explained in ${lang}",
      "usage": "Usage notes and collocations in ${lang}",
      "example": "Example sentence containing the word, with ${lang} translation"
    }
  ],
  "grammar_points": [
    {
      "point": "Name of the grammar point",
      "explanation": "Detailed explanation in ${lang}",
      "example": "Example sentence using the grammar point, with ${lang} translation"
    }
  ],
  "cultural_context": "Cultural background info in ${lang} (if applicable, else null)",
  "difficulty_level": "beginner | intermediate | advanced",
  "learning_tips": "Learning advice for this segment in ${lang}"
}

Ensure all explanations, meanings, and descriptive text are written in ${lang}.`;
}

/** Sentence explanation; parse the reply with `parseSegmentExplanation`. */
export function explainPrompt(text: string, targetLanguage: string): PromptMessages {
  return {
    task: "explain",
    version: PROMPT_VERSION.explain,
    system: explainSystemPrompt(text, targetLanguage),
    user: `Analyze this: ${text}`,
  };
}

// MARK: - translate

/** Plain translation; the reply is the translated text only. */
export function translatePrompt(text: string, targetLanguage: string): PromptMessages {
  const lang = nativeLanguageName(targetLanguage);
  return {
    task: "translate",
    version: PROMPT_VERSION.translate,
    system:
      `You are a professional translator. Translate the following text to ${lang}. ` +
      "Preserve the original meaning and tone. Only return the translated text without any explanations.",
    user: text,
    temperature: 0.3,
  };
}

// MARK: - wordGloss

/** Short in-context dictionary entry; parse with `parseWordGloss`. */
export function wordGlossPrompt(word: string, sentence: string, targetLanguage: string): PromptMessages {
  const lang = nativeLanguageName(targetLanguage);
  return {
    task: "wordGloss",
    version: PROMPT_VERSION.wordGloss,
    system: `You are a bilingual dictionary. The user's native language is ${lang}.
Given a word and the sentence it appears in, explain that word **as used in that sentence**. Return ONLY this JSON, with no markdown fences and no extra text:

{
  "word": "the dictionary form of the word",
  "reading": "Pronunciation (Hiragana for Japanese, Pinyin for Chinese, IPA for English); omit if not applicable",
  "meaning": "A concise meaning in ${lang}, one line",
  "usage": "Part of speech and a short note on how it is used here, in ${lang}",
  "example": "One short example sentence using the word"
}

Keep every field short. Write meaning and usage in ${lang}.`,
    user: `Word: ${word}\nSentence: ${sentence}`,
  };
}

// MARK: - webClean

/**
 * Web page cleanup: the model returns line numbers to drop, never rewritten text,
 * so learning material stays verbatim.
 */
export function webCleanPrompt(lines: readonly { index: number; preview: string }[], wantTitle: boolean): PromptMessages {
  const schema = wantTitle
    ? `{"drop": [2, 5, 6], "title": "the clean article title, or an empty string if unclear"}`
    : `{"drop": [2, 5, 6]}`;
  const system = `You are cleaning a web page that was converted to plain text, so it can be used as language-learning material.

You will receive numbered lines. Decide which lines are NOT part of the main article body.

DROP a line when it is:
- site navigation, menus, breadcrumbs, buttons, search boxes, login/subscribe prompts
- advertisements, promotional blurbs, paywall or membership pitches
- related/recommended article lists, "hot posts", tag clouds, category lists, pagination
- share widgets, like/favorite/view counters, comment threads, comment forms
- author bio boxes, editor signatures, copyright and legal footers, contact info, ICP/registration numbers
- cookie or privacy banners, app-download prompts, "click here", "read more", "back to top"
- standalone metadata that is not part of the text: bare timestamps, view counts, image credits, source attributions

KEEP a line when it is:
- the article title, headings and subheadings
- any paragraph, sentence, dialogue or list item of the main body
- lyrics, poems, quotes, or code that belong to the article
- anything you are not sure about — when in doubt, KEEP it

Rules:
- Judge each line only by whether it belongs to the article body, never by whether it is interesting or well written.
- Never rewrite, translate, summarize or reorder anything. You only report line numbers.
- Long lines are truncated for review and marked with "(len=N)", where N is the real character count. A long line is almost always body text.
- Return ONLY raw JSON, with no markdown fences and no explanation:
${schema}`;
  return {
    task: "webClean",
    version: PROMPT_VERSION.webClean,
    system,
    user: `Lines to review:\n${lines.map((l) => `[${l.index}] ${l.preview}`).join("\n")}`,
  };
}

export function parseWebCleanResponse(content: string): { drop: number[]; title: string | null } {
  const o = parseLlmJson(content) as Record<string, unknown>;
  const drop = Array.isArray(o.drop) ? o.drop.filter((n): n is number => Number.isInteger(n)) : [];
  const title = typeof o.title === "string" && o.title.trim() ? o.title.trim() : null;
  return { drop, title };
}

// MARK: - translateLyrics

export interface LyricsPromptInput {
  lines: readonly string[];
  targetLanguage: string;
  title?: string;
  artist?: string;
}

/**
 * Whole-song translation in one request (keeps context and rhyme), aligned line by line.
 * Reply: JSON array of {"i": n, "translation": "..."} — parse with `parseLineTranslations`.
 */
export function translateLyricsPrompt(input: LyricsPromptInput): PromptMessages {
  const lang = nativeLanguageName(input.targetLanguage);
  const header = [input.title && `Title: ${input.title}`, input.artist && `Artist: ${input.artist}`]
    .filter(Boolean)
    .join("\n");
  const numbered = input.lines.map((line, i) => `[${i + 1}] ${line}`).join("\n");
  return {
    task: "translateLyrics",
    version: PROMPT_VERSION.translateLyrics,
    system: `You are a professional lyrics translator. Translate the song lyrics the user sends into natural, singable ${lang}.

Rules:
- The input has ${input.lines.length} numbered lines. Return exactly ${input.lines.length} items, one per input line, in the same order, with the same numbers.
- Never merge, split, skip or reorder lines, even when a sentence runs across several lines.
- Use the whole song as context: keep the tone, imagery and any recurring phrases consistent.
- Keep repeated lines translated identically.
- If a line is empty, only a vocalization (e.g. "oh", "la la"), or already in ${lang}, return it unchanged.
- Return ONLY raw JSON, with no markdown fences and no explanation:
[{"i": 1, "translation": "..."}, {"i": 2, "translation": "..."}]`,
    user: `${header ? `${header}\n\n` : ""}Lyrics:\n${numbered}`,
    temperature: 0.3,
  };
}

// MARK: - translateChapter

export interface ChapterPromptInput {
  items: readonly { id: string; text: string }[];
  targetLanguage: string;
  bookTitle?: string;
  chapterTitle?: string;
}

/** Soft cap per request; callers should batch longer chapters (desktop uses 30). */
export const CHAPTER_BATCH_SIZE = 30;

/**
 * Batch translation of consecutive chapter segments (successor of desktop `batch_translate`).
 * Reply: JSON array of {"id": "...", "translation": "..."} — parse with `parseBatchTranslations`.
 */
export function translateChapterPrompt(input: ChapterPromptInput): PromptMessages {
  const lang = nativeLanguageName(input.targetLanguage);
  const context = [input.bookTitle && `Book: ${input.bookTitle}`, input.chapterTitle && `Chapter: ${input.chapterTitle}`]
    .filter(Boolean)
    .join("\n");
  const numbered = input.items.map((item) => `[${item.id}] ${item.text}`).join("\n");
  return {
    task: "translateChapter",
    version: PROMPT_VERSION.translateChapter,
    system: `You are a professional literary translator. Translate the numbered passages of a book into natural, fluent ${lang}.

Rules:
- The passages are consecutive sentences of one chapter; use them as context for each other.
- Translate every passage separately. Return exactly one item per passage, using its id verbatim.
- Preserve meaning, tone, names and dialogue punctuation. Do not add notes or explanations.
- Return ONLY raw JSON, with no markdown fences and no explanation:
[{"id": "passage id", "translation": "..."}]`,
    user: `${context ? `${context}\n\n` : ""}Passages:\n${numbered}`,
    temperature: 0.3,
  };
}

// MARK: - response parsing for batch tasks

function arrayOf(content: string): unknown[] {
  return parseLlmJson(content, "array") as unknown[];
}

export interface LineTranslations {
  /** Always `expectedCount` long; missing lines are "". */
  translations: string[];
  /** False when the model returned a different number of lines or skipped some. */
  aligned: boolean;
}

/**
 * Align a line-by-line translation reply. Accepts `[{"i", "translation"}]` or a plain
 * `["..."]` array. When `aligned` is false, re-prompt with `lineAlignmentRetryMessage`.
 */
export function parseLineTranslations(content: string, expectedCount: number): LineTranslations {
  const items = arrayOf(content);
  const translations = Array.from({ length: expectedCount }, () => "");
  const seen = new Set<number>();

  items.forEach((item, pos) => {
    let index = pos;
    let text: unknown = item;
    if (typeof item === "object" && item !== null) {
      const o = item as Record<string, unknown>;
      const i = typeof o.i === "string" ? Number(o.i) : o.i;
      if (typeof i === "number" && Number.isInteger(i)) index = i - 1;
      text = o.translation ?? o.t ?? o.text;
    }
    if (typeof text !== "string" || index < 0 || index >= expectedCount || seen.has(index)) return;
    translations[index] = text;
    seen.add(index);
  });

  return { translations, aligned: items.length === expectedCount && seen.size === expectedCount };
}

/** Follow-up user message asking the model to fix a misaligned lyrics translation. */
export function lineAlignmentRetryMessage(expectedCount: number, receivedCount: number): string {
  return (
    `Your answer had ${receivedCount} items but the lyrics have ${expectedCount} lines. ` +
    `Return the full translation again as exactly ${expectedCount} items, one per numbered line, ` +
    `same numbers, same order. Return ONLY the JSON array.`
  );
}

/** Parse a `translateChapter` reply into id → translation pairs (unknown shapes dropped). */
export function parseBatchTranslations(content: string): { id: string; translation: string }[] {
  return arrayOf(content).flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "number" ? String(o.id) : o.id;
    return typeof id === "string" && typeof o.translation === "string" ? [{ id, translation: o.translation }] : [];
  });
}
