import { describe, expect, it } from "vitest";
import { HybridClock, compareHlc, formatHlc, isValidHlc, legacyHlc, nodeIdFromDevice, parseHlc } from "../src/hlc";

describe("hlc", () => {
  it("formats and parses", () => {
    const s = formatHlc({ wall: 1727500000123, counter: 1, node: "a1b2c3d4" });
    expect(s).toBe("1727500000123-0001-a1b2c3d4");
    expect(parseHlc(s)).toEqual({ wall: 1727500000123, counter: 1, node: "a1b2c3d4" });
    expect(isValidHlc("123-0001-a1b2c3d4")).toBe(false);
    expect(() => parseHlc("nope")).toThrow();
  });

  it("derives node ids from device ids", () => {
    expect(nodeIdFromDevice("D7F1A2B3-0000-4000-8000-000000000000")).toBe("d7f1a2b3");
    expect(nodeIdFromDevice("ab")).toBe("ab000000");
  });

  it("orders lexicographically", () => {
    expect(compareHlc("0000000000002-0000-00000000", "0000000000010-0000-00000000")).toBe(-1);
    expect(compareHlc(legacyHlc("2026-09-28T10:00:00Z"), legacyHlc("2026-09-28T10:00:00Z"))).toBe(0);
    expect(legacyHlc("2026-09-28T10:00:00Z")).toBe(`${Date.parse("2026-09-28T10:00:00Z")}-0000-00000000`);
  });

  it("ticks monotonically when the wall clock stalls or goes back", () => {
    let now = 1000;
    const clock = new HybridClock("aaaaaaaa", null, () => now);
    const a = clock.tick();
    const b = clock.tick();
    now = 500;
    const c = clock.tick();
    expect(parseHlc(a)).toMatchObject({ wall: 1000, counter: 0 });
    expect(parseHlc(b)).toMatchObject({ wall: 1000, counter: 1 });
    expect(parseHlc(c)).toMatchObject({ wall: 1000, counter: 2 });
    now = 2000;
    expect(parseHlc(clock.tick())).toMatchObject({ wall: 2000, counter: 0 });
  });

  it("merges remote timestamps", () => {
    const now = 1000;
    const clock = new HybridClock("aaaaaaaa", "0000000001000-0003-aaaaaaaa", () => now);
    // both equal walls → max(counter)+1
    expect(clock.receive("0000000001000-0007-bbbbbbbb")).toBe("0000000001000-0008-aaaaaaaa");
    // remote ahead → remote counter + 1
    expect(clock.receive("0000000005000-0002-bbbbbbbb")).toBe("0000000005000-0003-aaaaaaaa");
    // local ahead → local counter + 1
    expect(clock.receive("0000000000010-0009-bbbbbbbb")).toBe("0000000005000-0004-aaaaaaaa");
    const later = new HybridClock("aaaaaaaa", "0000000001000-0003-aaaaaaaa", () => 9000);
    expect(later.receive("0000000002000-0005-bbbbbbbb")).toBe("0000000009000-0000-aaaaaaaa");
  });

  it("rolls the counter over into the wall", () => {
    const clock = new HybridClock("aaaaaaaa", "0000000001000-9999-aaaaaaaa", () => 0);
    expect(clock.tick()).toBe("0000000001001-0000-aaaaaaaa");
    expect(clock.current()).toBe("0000000001001-0000-aaaaaaaa");
  });
});
