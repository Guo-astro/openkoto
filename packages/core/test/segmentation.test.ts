import { describe, expect, it } from "vitest";
import golden from "../../../openkoto-ios/Packages/OpenKotoKit/Tests/OKSegmentationTests/Fixtures/segmentation_golden.json";
import { segmentText, splitIntoSentences } from "../src/segmentation";

describe("segmentation golden (shared with iOS/Rust)", () => {
  for (const c of golden.cases) {
    it(c.name, () => {
      expect(segmentText(c.input)).toEqual(c.expected.map((e) => ({ text: e.text, isNewParagraph: e.newParagraph })));
    });
  }
});

describe("segmentation heuristics", () => {
  it("does not split common abbreviations or initials", () => {
    expect(splitIntoSentences("Dr. Smith and Mr. Lee met vs. the team.")).toEqual(["Dr. Smith and Mr. Lee met vs. the team."]);
    expect(splitIntoSentences("Written by A. B. Cooper.")).toEqual(["Written by A. B. Cooper."]);
    expect(splitIntoSentences("Visit the U.S.A. now.")).toEqual(["Visit the U.S.A. now."]);
  });

  it("absorbs closing quotes and brackets", () => {
    expect(splitIntoSentences("She said “Hello.” Bye.")).toEqual(["She said “Hello.”", "Bye."]);
    expect(splitIntoSentences("（本当に！）次。")).toEqual(["（本当に！）", "次。"]);
    expect(splitIntoSentences('He said "go." Then left.')).toEqual(['He said "go."', "Then left."]);
  });

  it("handles astral characters and empty input", () => {
    expect(splitIntoSentences("𠮷野家に行く。美味しい！")).toEqual(["𠮷野家に行く。", "美味しい！"]);
    expect(segmentText("")).toEqual([]);
    expect(segmentText("  \n\n ")).toEqual([]);
  });
});
