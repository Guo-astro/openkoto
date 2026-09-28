// Book parsing for `koto book import` — Node port of apps/web/src/lib/books.ts (same
// chapter rules and size cap) without DOMParser: the EPUB XML/XHTML is read with a
// small tolerant tag scanner, which is plenty for OPF metadata and chapter text.

import { strFromU8, unzipSync } from "fflate";

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
export const MAX_CHAPTER_CHARS = 60_000;

const CHAPTER_HEADING =
  /^\s*(第[0-9０-９零〇一二三四五六七八九十百千两]+[章回节卷集部篇]|序章|序言|楔子|终章|尾声|后记|番外|Chapter\s+\d+|CHAPTER\s+[0-9IVXLC]+|Prologue|Epilogue)[^\n]{0,40}$/;

function splitOversized(chapters: ParsedChapter[]): ParsedChapter[] {
  const out: ParsedChapter[] = [];
  for (const ch of chapters) {
    if (ch.text.length <= MAX_CHAPTER_CHARS) {
      out.push(ch);
      continue;
    }
    let buf: string[] = [];
    let size = 0;
    let part = 1;
    const flush = () => {
      if (!buf.length) return;
      out.push({ title: `${ch.title} (${part++})`, text: buf.join("\n") });
      buf = [];
      size = 0;
    };
    for (const p of ch.text.split(/\n+/)) {
      if (size + p.length > MAX_CHAPTER_CHARS) flush();
      buf.push(p);
      size += p.length + 1;
    }
    flush();
  }
  return out;
}

export function decodeText(bytes: Uint8Array): string {
  // UTF-8 first; fall back to GB18030 (common for Chinese TXT novels).
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
  const chapters: ParsedChapter[] = [];
  let current: ParsedChapter = { title: "", text: "" };
  const body: string[] = [];
  const push = () => {
    current.text = body.join("\n").trim();
    body.length = 0;
    if (current.text || current.title) chapters.push(current);
  };
  for (const line of text.split("\n")) {
    if (CHAPTER_HEADING.test(line)) {
      push();
      current = { title: line.trim(), text: "" };
    } else {
      body.push(line);
    }
  }
  push();
  const title = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const named = chapters.map((c, i) => ({ title: c.title || (i === 0 ? title : `#${i + 1}`), text: c.text })).filter((c) => c.text);
  return { title, author: null, language: null, format: "txt", chapters: splitOversized(named.length ? named : [{ title, text: text.trim() }]) };
}

// ---- tiny XML helpers -------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const name = m[1]!.toLowerCase();
    out[name] = decodeEntities(m[3] ?? m[4] ?? "");
    const local = name.includes(":") ? name.slice(name.indexOf(":") + 1) : null;
    if (local && !(local in out)) out[local] = out[name]!;
  }
  return out;
}

/** Opening tags with the given local name (namespace prefixes ignored). */
function tags(xml: string, local: string): Record<string, string>[] {
  const re = new RegExp(`<(?:[\\w-]+:)?${local}\\b[^>]*>`, "gi");
  return [...xml.matchAll(re)].map((m) => attrs(m[0]));
}

/** Text content of the first element with the given local name. */
function elementText(xml: string, local: string): string | null {
  const re = new RegExp(`<(?:[\\w-]+:)?${local}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${local}>`, "i");
  const m = re.exec(xml);
  if (!m) return null;
  const text = decodeEntities(m[1]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  return text || null;
}

const BLOCK_TAGS = "p|div|h[1-6]|li|blockquote|pre|tr|section|article|dt|dd|br|hr|table|ul|ol|header|footer|figure|figcaption|aside";

/** Block-aware XHTML → text; ruby annotations (rt/rp), scripts and styles are dropped. */
export function xhtmlToText(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return decodeEntities(
    body
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<(script|style|rt|rp|head)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<(rt|rp)\b[^>]*\/>/gi, "")
      .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
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

export function parseEpub(bytes: Uint8Array, fileName: string): ParsedBook {
  const files = unzipSync(bytes);
  const read = (path: string) => {
    const f = files[path];
    if (!f) throw new Error(`missing ${path} in EPUB`);
    return strFromU8(f);
  };

  const opfPath = tags(read("META-INF/container.xml"), "rootfile")[0]?.["full-path"];
  if (!opfPath) throw new Error("invalid EPUB: no rootfile");
  const opf = read(opfPath);
  const metadata = /<(?:[\w-]+:)?metadata\b[\s\S]*?<\/(?:[\w-]+:)?metadata>/i.exec(opf)?.[0] ?? opf;

  const manifest = new Map<string, { href: string; type: string }>();
  for (const item of tags(opf, "item")) manifest.set(item.id ?? "", { href: item.href ?? "", type: item["media-type"] ?? "" });

  const chapters: ParsedChapter[] = [];
  for (const ref of tags(opf, "itemref")) {
    const item = manifest.get(ref.idref ?? "");
    if (!item || !/html/.test(item.type)) continue;
    const path = resolvePath(opfPath, item.href);
    if (!files[path]) continue;
    const html = read(path);
    const text = xhtmlToText(html);
    if (!text.trim()) continue;
    const heading = elementText(html, "h1") ?? elementText(html, "h2") ?? elementText(html, "h3") ?? elementText(html, "title");
    chapters.push({ title: heading || `#${chapters.length + 1}`, text });
  }
  if (!chapters.length) throw new Error("no readable chapters (image-only or fixed-layout EPUB?)");
  return {
    title: elementText(metadata, "title") ?? fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, ""),
    author: elementText(metadata, "creator"),
    language: elementText(metadata, "language"),
    format: "epub",
    chapters: splitOversized(chapters),
  };
}

export function parseBook(bytes: Uint8Array, fileName: string): ParsedBook {
  return /\.epub$/i.test(fileName) ? parseEpub(bytes, fileName) : parseTxt(bytes, fileName);
}

/** "1-5,8" (1-based, inclusive) → sorted unique 0-based indexes. */
export function parseChapterRanges(spec: string, count: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+)?)?$/.exec(part);
    if (!m) throw new Error(`invalid chapter range "${part}"`);
    const from = Number(m[1]);
    const to = m[2] !== undefined ? Number(m[2]) : part.includes("-") ? count : from;
    if (from < 1 || to < from) throw new Error(`invalid chapter range "${part}"`);
    for (let i = from; i <= Math.min(to, count); i++) out.add(i - 1);
  }
  return [...out].sort((a, b) => a - b);
}
