import { describe, expectTypeOf, expect, it } from "vitest";
import { membershipId, parseMembershipId, type FavoriteVocabulary, type LyricsMeta, type PayloadOf } from "../src/models";
import type { JsonObject } from "../src/protocol";

describe("models", () => {
  it("maps record types to payloads", () => {
    expectTypeOf<PayloadOf<"Vocabulary">>().toEqualTypeOf<FavoriteVocabulary>();
    expectTypeOf<PayloadOf<"LyricsMeta">>().toEqualTypeOf<LyricsMeta>();
    expectTypeOf<PayloadOf<"Setting">>().toEqualTypeOf<JsonObject>();
  });

  it("builds membership ids", () => {
    expect(membershipId("AAA-1", "BBB-2")).toBe("aaa-1_bbb-2");
    expect(parseMembershipId("aaa-1_bbb-2")).toEqual({ vocabularyId: "aaa-1", packId: "bbb-2" });
    expect(parseMembershipId("nounderscore")).toBeNull();
  });
});
