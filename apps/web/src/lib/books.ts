import { unzipSync, strFromU8 } from "fflate";

export interface ParsedChapter {
  title: string;
  text: string;
}

export interface ParsedBook {
  title: string;
  author: string | null;
  language: string | null;
  format: "epub" | "txt";
  chapters: ParsedChapter[];
}

// A chapter record's payload must stay well under the 512 KB inline limit.
const MAX_CHAPTER_CHARS = 60_000;

const CHAPTER_HEADING =
  /^\s*(第[0-9０-９零〇一二三四五六七八九十百千两]+[章回节卷集部篇]|序章|序言|楔子|终章|尾声|后记|番外|Chapter\s+\d+|CHAPTER\s+[0-9IVXLC]+|Prologue|Epilogue)[^\n]{0,40}$/;

function splitOversized(chapters: ParsedChapter[]): ParsedChapter[] {
  const out: ParsedChapter[] = [];
  for (const ch of chapters) {
    if (ch.text.length <= MAX_CHAPTER_CHARS) {
      out.push(ch);
      continue;
    }
    const paragraphs = ch.text.split(/\n+/);
    let buf: string[] = [];
    let size = 0;
    let part = 1;
    const flush = () => {
      if (!buf.length) return;
      out.push({ title: `${ch.title} (${part++})`, text: buf.join("\n") });
      buf = [];
      size = 0;
    };
    for (const p of paragraphs) {
      if (size + p.length > MAX_CHAPTER_CHARS) flush();
      buf.push(p);
      size += p.length + 1;
    }
    flush();
  }
  return out;
}

function decodeText(bytes: Uint8Array): string {
  // Try UTF-8 first; fall back to GB18030 (common for Chinese TXT novels).
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad > utf8.length / 1000) {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      return utf8;
    }
  }
  return utf8.replace(/^﻿/, "");
}

export function parseTxt(bytes: Uint8Array, fileName: string): ParsedBook {
  const text = decodeText(bytes).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const chapters: ParsedChapter[] = [];
  let current: ParsedChapter = { title: "", text: "" };
  const body: string[] = [];
  const push = () => {
    current.text = body.join("\n").trim();
    body.length = 0;
    if (current.text || current.title) chapters.push(current);
  };
  for (const line of lines) {
    if (CHAPTER_HEADING.test(line)) {
      push();
      current = { title: line.trim(), text: "" };
    } else {
      body.push(line);
    }
  }
  push();
  const title = fileName.replace(/\.[^.]+$/, "");
  const named = chapters.map((c, i) => ({ title: c.title || (i === 0 ? title : `#${i + 1}`), text: c.text })).filter((c) => c.text);
  return { title, author: null, language: null, format: "txt", chapters: splitOversized(named.length ? named : [{ title, text: text.trim() }]) };
}

function resolvePath(base: string, href: string): string {
  const parts = (base.includes("/") ? base.slice(0, base.lastIndexOf("/") + 1) : "").concat(decodeURIComponent(href.split("#")[0]!)).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

const BLOCK = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "PRE", "TR", "SECTION", "ARTICLE", "BR", "DT", "DD"]);

/** Block-aware text extraction; ruby annotations (rt/rp) are dropped. */
function htmlToText(doc: Document): string {
  const out: string[] = [];
  let line = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      line += node.textContent?.replace(/\s+/g, " ") ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (tag === "RT" || tag === "RP" || tag === "SCRIPT" || tag === "STYLE") return;
    const block = BLOCK.has(tag);
    if (block && line.trim()) {
      out.push(line.trim());
      line = "";
    }
    for (const child of Array.from(el.childNodes)) walk(child);
    if (block && line.trim()) {
      out.push(line.trim());
      line = "";
    }
  };
  if (doc.body) walk(doc.body);
  if (line.trim()) out.push(line.trim());
  return out.join("\n");
}

export function parseEpub(bytes: Uint8Array, fileName: string): ParsedBook {
  const files = unzipSync(bytes);
  const read = (path: string) => {
    const f = files[path];
    if (!f) throw new Error(`missing ${path} in EPUB`);
    return strFromU8(f);
  };
  const xml = (s: string, type: DOMParserSupportedType = "application/xml") => new DOMParser().parseFromString(s, type);

  const container = xml(read("META-INF/container.xml"));
  const opfPath = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) throw new Error("invalid EPUB: no rootfile");
  const opf = xml(read(opfPath));
  const meta = (name: string) => opf.getElementsByTagNameNS("*", name)[0]?.textContent?.trim() || null;

  const manifest = new Map<string, { href: string; type: string }>();
  for (const item of Array.from(opf.getElementsByTagNameNS("*", "item"))) {
    manifest.set(item.getAttribute("id") ?? "", { href: item.getAttribute("href") ?? "", type: item.getAttribute("media-type") ?? "" });
  }

  const chapters: ParsedChapter[] = [];
  for (const ref of Array.from(opf.getElementsByTagNameNS("*", "itemref"))) {
    const item = manifest.get(ref.getAttribute("idref") ?? "");
    if (!item || !/html/.test(item.type)) continue;
    const path = resolvePath(opfPath, item.href);
    if (!files[path]) continue;
    const doc = xml(read(path), "application/xhtml+xml");
    const parsed = doc.getElementsByTagName("parsererror").length ? xml(read(path), "text/html") : doc;
    const text = htmlToText(parsed);
    if (!text.trim()) continue;
    const heading = parsed.querySelector("h1, h2, h3")?.textContent?.trim() || parsed.querySelector("title")?.textContent?.trim();
    chapters.push({ title: heading || `#${chapters.length + 1}`, text });
  }
  if (!chapters.length) throw new Error("no readable chapters (image-only or fixed-layout EPUB?)");
  return {
    title: meta("title") ?? fileName.replace(/\.[^.]+$/, ""),
    author: meta("creator"),
    language: meta("language"),
    format: "epub",
    chapters: splitOversized(chapters),
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
