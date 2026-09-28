import { describe, expect, it } from "vitest";
import { detectLyricsFormat, parseLrc, parseLyrics, parseSrt, toLrc } from "../src/lrc";

const SAMPLE = `[ti:Song]
[ar:Artist]
[al:Album]
[by:someone]
[length: 01:00]
[re:tool]
[00:12.00]First line
[00:05.5]Intro
[00:20.123][00:40.00]Chorus <00:20.50>word <00:21.00>tags

[00:30.00]
[00:35]Last-ish
`;

describe("parseLrc", () => {
  it("parses metadata, multiple stamps, sorting, and ends", () => {
    const doc = parseLrc(SAMPLE);
    expect(doc.format).toBe("lrc");
    expect(doc.meta).toMatchObject({ title: "Song", artist: "Artist", album: "Album", by: "someone", length: 60 });
    expect(doc.meta.extra).toEqual({ re: "tool" });
    expect(doc.lines).toEqual([
      { startTime: 5.5, endTime: 12, text: "Intro" },
      { startTime: 12, endTime: 20.123, text: "First line" },
      { startTime: 20.123, endTime: 30, text: "Chorus word tags" },
      { startTime: 35, endTime: 40, text: "Last-ish" },
      { startTime: 40, endTime: 60, text: "Chorus word tags" },
    ]);
  });

  it("keeps empty timed lines on request", () => {
    const doc = parseLrc(SAMPLE, { keepEmpty: true });
    expect(doc.lines.find((l) => l.text === "")).toEqual({ startTime: 30, endTime: 35, text: "" });
  });

  it("applies offset and trailing duration", () => {
    const doc = parseLrc("[offset:+500]\n[00:01.00]a\n[00:02.00]b");
    expect(doc.meta.offsetMs).toBe(500);
    expect(doc.lines).toEqual([
      { startTime: 0.5, endTime: 1.5, text: "a" },
      { startTime: 1.5, endTime: 6.5, text: "b" },
    ]);
    expect(parseLrc("[offset:-250]\n[00:01.00]a", { applyOffset: false }).lines[0]!.startTime).toBe(1);
    expect(parseLrc("[offset:-250]\n[00:01.00]a").lines[0]!.startTime).toBe(1.25);
  });

  it("supports 3-digit fractions and long minutes", () => {
    expect(parseLrc("[01:02.345]x\n[100:00.00]y").lines.map((l) => l.startTime)).toEqual([62.345, 6000]);
  });

  it("falls back to plain text without timestamps", () => {
    const doc = parseLrc("[ti:T]\n\nline one\r\nline two\n");
    expect(doc.format).toBe("txt");
    expect(doc.meta.title).toBe("T");
    expect(doc.lines).toEqual([
      { startTime: null, endTime: null, text: "line one" },
      { startTime: null, endTime: null, text: "line two" },
    ]);
  });

  it("round-trips through toLrc", () => {
    const doc = parseLrc(SAMPLE);
    const text = toLrc(doc);
    expect(text.startsWith("[ti:Song]\n[ar:Artist]\n[al:Album]\n[by:someone]\n[length:01:00]\n[00:05.50]Intro\n")).toBe(true);
    expect(parseLrc(text).lines).toEqual(doc.lines);
    expect(toLrc({ lines: [{ startTime: null, endTime: null, text: "plain" }] })).toBe("plain\n");
  });
});

describe("SRT and detection", () => {
  const SRT = `1
00:00:01,000 --> 00:00:03,500
<i>Hello</i>
world

2
00:00:04.000 --> 00:00:05.000 align:start
Second

3
bad --> line
dropped
`;

  it("parses SRT cues", () => {
    expect(parseSrt(SRT).lines).toEqual([
      { startTime: 1, endTime: 3.5, text: "Hello world" },
      { startTime: 4, endTime: 5, text: "Second" },
    ]);
  });

  it("detects formats", () => {
    expect(detectLyricsFormat(SRT)).toBe("srt");
    expect(detectLyricsFormat(SAMPLE)).toBe("lrc");
    expect(detectLyricsFormat("just\nwords")).toBe("txt");
    expect(parseLyrics("a\n\nb").lines.map((l) => l.text)).toEqual(["a", "b"]);
    expect(parseLyrics(SRT).format).toBe("srt");
  });
});
