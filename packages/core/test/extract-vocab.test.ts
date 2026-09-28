import { describe, expect, it } from "vitest";
import { extractVocabPrompt, extractVocabulary, parseExtractedVocab } from "../src/index";

describe("extractVocab", () => {
  it("builds a versioned prompt with the limit and level", () => {
    const p = extractVocabPrompt({ text: "懐かしい歌", targetLanguage: "zh", max: 5, level: "N3" });
    expect(p.version).toBe("extract-vocab-v1");
    expect(p.system).toContain("at most 5");
    expect(p.system).toContain("N3");
    expect(p.user).toBe("懐かしい歌");
  });

  it("parses, dedupes and caps items", () => {
    const reply = '```json\n[{"word":"懐かしい","reading":"なつかしい","meaning":"怀念","example":"懐かしい歌"},{"word":"懐かしい","meaning":"x"},{"word":"","meaning":"y"},{"word":"歌","meaning":"歌曲","reading":""}]\n```';
    expect(parseExtractedVocab(reply)).toEqual([
      { word: "懐かしい", reading: "なつかしい", meaning: "怀念", example: "懐かしい歌" },
      { word: "歌", meaning: "歌曲" },
    ]);
    expect(parseExtractedVocab(reply, 1)).toHaveLength(1);
  });

  it("runs through a ChatFn", async () => {
    const items = await extractVocabulary(async () => ({ content: '[{"word":"a","meaning":"b"}]' }), { text: "a", targetLanguage: "en" });
    expect(items).toEqual([{ word: "a", meaning: "b" }]);
  });
});
