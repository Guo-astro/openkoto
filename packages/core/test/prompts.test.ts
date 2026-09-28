import { describe, expect, it } from "vitest";
import {
  PROMPT_VERSION,
  explainPrompt,
  lineAlignmentRetryMessage,
  nativeLanguageName,
  parseBatchTranslations,
  parseLineTranslations,
  parseWebCleanResponse,
  translateChapterPrompt,
  translateLyricsPrompt,
  translatePrompt,
  webCleanPrompt,
  wordGlossPrompt,
} from "../src/prompts";

describe("prompt library", () => {
  it("maps language codes like iOS", () => {
    expect(nativeLanguageName("zh-CN")).toBe("中文");
    expect(nativeLanguageName("zh-TW")).toBe("繁體中文");
    expect(nativeLanguageName("ja")).toBe("Japanese");
    expect(nativeLanguageName("xx")).toBe("中文");
  });

  it("builds versioned prompts", () => {
    const e = explainPrompt("猫が好き。", "en");
    expect(e.version).toBe(PROMPT_VERSION.explain);
    expect(e.user).toBe("Analyze this: 猫が好き。");
    expect(e.system).toContain("The user's native language is English.");
    expect(e.system).toContain('"grammar_points": [');
    expect(e.system).toContain("---\n猫が好き。\n---");

    const t = translatePrompt("hello", "ja");
    expect(t.system).toBe(
      "You are a professional translator. Translate the following text to Japanese. Preserve the original meaning and tone. Only return the translated text without any explanations.",
    );
    expect(t.user).toBe("hello");

    const g = wordGlossPrompt("run", "I run daily.", "zh");
    expect(g.user).toBe("Word: run\nSentence: I run daily.");
    expect(g.system).toContain("explain that word **as used in that sentence**");
    expect(g.version).toBe("gloss-v1");

    const w = webCleanPrompt([{ index: 3, preview: "Home | News" }], true);
    expect(w.user).toBe("Lines to review:\n[3] Home | News");
    expect(w.system).toContain('"title"');
    expect(webCleanPrompt([], false).system).not.toContain('"title"');
  });

  it("builds lyrics and chapter prompts", () => {
    const l = translateLyricsPrompt({ lines: ["a", "b", "c"], targetLanguage: "zh", title: "T" });
    expect(l.version).toBe(PROMPT_VERSION.translateLyrics);
    expect(l.system).toContain("Return exactly 3 items");
    expect(l.user).toBe("Title: T\n\nLyrics:\n[1] a\n[2] b\n[3] c");
    const c = translateChapterPrompt({ items: [{ id: "s1", text: "x" }], targetLanguage: "en" });
    expect(c.user).toBe("Passages:\n[s1] x");
    expect(c.version).toBe(PROMPT_VERSION.translateChapter);
  });
});

describe("response parsing", () => {
  it("aligns lyric translations by index", () => {
    const ok = parseLineTranslations('[{"i":2,"translation":"B"},{"i":1,"translation":"A"}]', 2);
    expect(ok).toEqual({ translations: ["A", "B"], aligned: true });
    const plain = parseLineTranslations('```json\n["A", "B", "C"]\n```', 2);
    expect(plain).toEqual({ translations: ["A", "B"], aligned: false });
    const missing = parseLineTranslations('[{"i":1,"translation":"A"}]', 3);
    expect(missing).toEqual({ translations: ["A", "", ""], aligned: false });
    expect(lineAlignmentRetryMessage(3, 1)).toContain("exactly 3 items");
  });

  it("parses batch chapter translations", () => {
    expect(parseBatchTranslations('[{"id":"s1","translation":"x"},{"id":2,"translation":"y"},{"foo":1}]')).toEqual([
      { id: "s1", translation: "x" },
      { id: "2", translation: "y" },
    ]);
  });

  it("parses web clean responses", () => {
    expect(parseWebCleanResponse('{"drop":[1,2,"x"],"title":" Title "}')).toEqual({ drop: [1, 2], title: "Title" });
    expect(parseWebCleanResponse('{"drop":[]}')).toEqual({ drop: [], title: null });
  });
});
