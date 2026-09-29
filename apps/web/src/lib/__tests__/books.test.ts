import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseEpub, parseTxt } from "../books";

describe("parseTxt", () => {
  it("splits Chinese chapter headings and keeps the prologue", () => {
    const text = "序言\n很久以前。\n第一章 出发\n他出发了。\n第二章 归来\n他回来了。";
    const book = parseTxt(new TextEncoder().encode(text), "旅途.txt");
    expect(book.title).toBe("旅途");
    expect(book.chapters.map((c) => c.title)).toEqual(["序言", "第一章 出发", "第二章 归来"]);
    expect(book.chapters[1]!.text).toBe("他出发了。");
  });

  it("splits oversized chapters under the inline payload limit", () => {
    const para = "あ".repeat(1000);
    const text = Array.from({ length: 130 }, () => para).join("\n");
    const book = parseTxt(new TextEncoder().encode(text), "long.txt");
    expect(book.chapters.length).toBeGreaterThan(1);
    expect(book.chapters.every((c) => c.text.length <= 60_000)).toBe(true);
  });
});

describe("parseEpub", () => {
  it("reads spine order, metadata and drops ruby annotations", () => {
    const epub = zipSync({
      mimetype: strToU8("application/epub+zip"),
      "META-INF/container.xml": strToU8(
        '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
      ),
      "OEBPS/content.opf": strToU8(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>小さな本</dc:title><dc:creator>作者</dc:creator><dc:language>ja</dc:language></metadata><manifest><item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>',
      ),
      "OEBPS/text/c1.xhtml": strToU8(
        '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一話</h1><p><ruby>桜<rt>さくら</rt></ruby>が咲いた。</p></body></html>',
      ),
      "OEBPS/text/c2.xhtml": strToU8('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h2>第二話</h2><p>雨。</p></body></html>'),
    });
    const book = parseEpub(epub, "x.epub");
    expect(book).toMatchObject({ title: "小さな本", author: "作者", language: "ja", format: "epub" });
    expect(book.chapters.map((c) => c.title)).toEqual(["第一話", "第二話"]);
    expect(book.chapters[0]!.text).toContain("桜が咲いた。");
    expect(book.chapters[0]!.text).not.toContain("さくら");
  });
});
