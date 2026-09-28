import { describe, expect, it } from "vitest";
import type { LocalChange } from "@openkoto/client";
import { addVocabulary, gradeCard, newVocabulary, normalizeWord, parseWordList, undoReview } from "../vocab";

function recorder() {
  const writes: { type: string; id: string; change: LocalChange }[] = [];
  return { writes, write: async (type: string, id: string, change: LocalChange) => void writes.push({ type, id, change }) };
}

describe("vocab helpers", () => {
  it("normalizes with NFKC, trim and lowercase", () => {
    expect(normalizeWord(" Ｈｅｌｌｏ ")).toBe("hello");
  });

  it("merges duplicates by filling empty fields", async () => {
    const existing = newVocabulary({ word: "Hello", meaning: "" });
    const r = recorder();
    const merged = await addVocabulary(r.write as never, [existing], { word: "hello", meaning: "你好" });
    expect(merged.id).toBe(existing.id);
    expect(merged.meaning).toBe("你好");
    expect(r.writes).toHaveLength(1);
  });

  it("parses CSV and TSV word lists", () => {
    expect(parseWordList("# comment\n桜,cherry blossom,さくら\n空\tsky")).toEqual([
      { word: "桜", meaning: "cherry blossom", reading: "さくら", example: undefined },
      { word: "空", meaning: "sky", reading: undefined, example: undefined },
    ]);
  });

  it("grades with an immutable event and undoes with a void marker", async () => {
    const card = newVocabulary({ word: "桜", meaning: "cherry" });
    const r = recorder();
    const { card: next, event } = await gradeCard(r.write as never, card, 3);
    expect(next.reviewCount).toBe(1);
    expect(r.writes.map((w) => w.type)).toEqual(["ReviewEvent", "Vocabulary"]);
    await undoReview(r.write as never, card, event);
    const voidEvent = r.writes[2]!.change as { payload: { voidsEventId: string; grade: number } };
    expect(voidEvent.payload).toMatchObject({ voidsEventId: event.id, grade: 0 });
    const restored = r.writes[3]!.change as { payload: { reviewCount: number } };
    expect(restored.payload.reviewCount).toBe(0);
  });
});
