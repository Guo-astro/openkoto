// Lyrics import: LRC (incl. enhanced word tags), SRT, and plain-text fallback.
// Output times are in seconds. See docs/plans/2026-09-28-web-and-cloud-platform-design.md §8.3.

import type { LyricsSourceFormat } from "./models";

export interface LyricsMetaTags {
  title?: string;
  artist?: string;
  album?: string;
  by?: string;
  /** Seconds, from `[length:mm:ss]`. */
  length?: number;
  /** Raw `[offset:±ms]` value. Positive = lyrics shown earlier. */
  offsetMs?: number;
  /** Any other `[key:value]` header tags. */
  extra?: Record<string, string>;
}

export interface LyricLine {
  /** Seconds; null for untimed (plain-text) lyrics. */
  startTime: number | null;
  endTime: number | null;
  text: string;
}

export interface ParsedLyrics {
  format: LyricsSourceFormat;
  meta: LyricsMetaTags;
  lines: LyricLine[];
}

export interface LrcParseOptions {
  /** Apply `[offset:]` to line times (default true). */
  applyOffset?: boolean;
  /** Keep timed lines with empty text (instrumental gaps). Default false; they still end the previous line. */
  keepEmpty?: boolean;
  /** Duration for the last line when `[length:]` is absent. Default 5s. */
  trailingSeconds?: number;
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/y;
const META_TAG = /^\[([a-zA-Z#]+):(.*)\]$/;
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

function normalizeNewlines(raw: string): string {
  return raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

function tagSeconds(min: string, sec: string, frac: string | undefined): number {
  const fraction = frac ? Number(frac) / 10 ** frac.length : 0;
  return Number(min) * 60 + Number(sec) + fraction;
}

/** "mm:ss", "mm:ss.xx" or "hh:mm:ss" → seconds. */
function clockSeconds(value: string): number | undefined {
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return undefined;
  let total = 0;
  for (const p of parts) {
    const n = Number(p);
    if (p === "" || !Number.isFinite(n) || n < 0) return undefined;
    total = total * 60 + n;
  }
  return total;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

function applyMeta(meta: LyricsMetaTags, key: string, value: string): void {
  const v = value.trim();
  switch (key.toLowerCase()) {
    case "ti":
      meta.title = v;
      break;
    case "ar":
      meta.artist = v;
      break;
    case "al":
      meta.album = v;
      break;
    case "by":
      meta.by = v;
      break;
    case "length": {
      const s = clockSeconds(v);
      if (s !== undefined) meta.length = s;
      break;
    }
    case "offset": {
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n)) meta.offsetMs = n;
      break;
    }
    default:
      (meta.extra ??= {})[key] = v;
  }
}

/** True when the text contains at least one LRC line timestamp. */
export function looksLikeLrc(raw: string): boolean {
  return /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(raw);
}

export function looksLikeSrt(raw: string): boolean {
  return /\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(raw);
}

export function detectLyricsFormat(raw: string): LyricsSourceFormat {
  if (looksLikeSrt(raw)) return "srt";
  if (looksLikeLrc(raw)) return "lrc";
  return "txt";
}

/**
 * Parse LRC. When no line carries a timestamp, falls back to plain text
 * (every non-empty, non-tag line becomes an untimed line) and reports format "txt".
 */
export function parseLrc(raw: string, opts: LrcParseOptions = {}): ParsedLyrics {
  const meta: LyricsMetaTags = {};
  const timed: { start: number; text: string; seq: number }[] = [];
  const untimed: string[] = [];
  let seq = 0;

  for (const rawLine of normalizeNewlines(raw).split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const stamps: number[] = [];
    let pos = 0;
    for (;;) {
      TIME_TAG.lastIndex = pos;
      const m = TIME_TAG.exec(line);
      if (!m) break;
      stamps.push(tagSeconds(m[1]!, m[2]!, m[3]));
      pos = TIME_TAG.lastIndex;
      while (line[pos] === " " || line[pos] === "\t") pos++;
    }

    if (stamps.length === 0) {
      const tag = META_TAG.exec(line);
      if (tag) applyMeta(meta, tag[1]!, tag[2]!);
      else untimed.push(line.replace(WORD_TAG, "").replace(/\s{2,}/g, " ").trim());
      continue;
    }

    const text = line.slice(pos).replace(WORD_TAG, "").replace(/\s{2,}/g, " ").trim();
    for (const start of stamps) timed.push({ start, text, seq: seq++ });
  }

  if (timed.length === 0) {
    return { format: "txt", meta, lines: untimed.filter(Boolean).map((text) => ({ startTime: null, endTime: null, text })) };
  }

  const shift = opts.applyOffset === false ? 0 : (meta.offsetMs ?? 0) / 1000;
  timed.sort((a, b) => a.start - b.start || a.seq - b.seq);
  const trailing = opts.trailingSeconds ?? 5;

  const all: LyricLine[] = timed.map((t, i) => {
    const start = Math.max(t.start - shift, 0);
    const next = timed[i + 1];
    let end: number;
    if (next) end = Math.max(next.start - shift, start);
    else if (meta.length !== undefined && meta.length > start) end = meta.length;
    else end = start + trailing;
    return { startTime: round3(start), endTime: round3(end), text: t.text };
  });

  return { format: "lrc", meta, lines: opts.keepEmpty ? all : all.filter((l) => l.text !== "") };
}

function formatLrcTime(seconds: number): string {
  const ms = Math.max(Math.round(seconds * 1000), 0);
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const frac = ms % 1000;
  // Centiseconds when exact (the common form), otherwise milliseconds.
  const fracText = frac % 10 === 0 ? String(frac / 10).padStart(2, "0") : String(frac).padStart(3, "0");
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${fracText}`;
}

/**
 * Serialize to LRC. Times are written as-is (already offset-adjusted by `parseLrc`),
 * so no `[offset:]` tag is emitted unless `includeOffset` is set.
 */
export function toLrc(
  doc: Pick<ParsedLyrics, "lines"> & { meta?: LyricsMetaTags },
  opts: { includeOffset?: boolean } = {},
): string {
  const out: string[] = [];
  const meta = doc.meta ?? {};
  if (meta.title) out.push(`[ti:${meta.title}]`);
  if (meta.artist) out.push(`[ar:${meta.artist}]`);
  if (meta.album) out.push(`[al:${meta.album}]`);
  if (meta.by) out.push(`[by:${meta.by}]`);
  if (meta.length !== undefined) out.push(`[length:${formatLrcTime(meta.length).slice(0, 5)}]`);
  if (opts.includeOffset && meta.offsetMs) out.push(`[offset:${meta.offsetMs > 0 ? "+" : ""}${meta.offsetMs}]`);
  doc.lines.forEach((line, i) => {
    if (line.startTime === null) {
      out.push(line.text);
      return;
    }
    out.push(`[${formatLrcTime(line.startTime)}]${line.text}`);
    // Preserve gaps (instrumental breaks) as an empty timed line.
    const next = doc.lines[i + 1];
    if (next?.startTime != null && line.endTime !== null && line.endTime < next.startTime) {
      out.push(`[${formatLrcTime(line.endTime)}]`);
    }
  });
  return out.join("\n") + "\n";
}

/** "HH:MM:SS,mmm" / "HH:MM:SS.mmm" / "MM:SS.mmm" → seconds. */
function srtSeconds(raw: string): number | undefined {
  return clockSeconds(raw.replace(",", "."));
}

function stripMarkup(line: string): string {
  return line
    .replace(/<[^>]*>/g, "")
    .replace(/\{[^}]*\}/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Parse SRT into lyric lines; multi-line cues are joined with a space. */
export function parseSrt(raw: string): ParsedLyrics {
  const lines: LyricLine[] = [];
  for (const block of normalizeNewlines(raw).split(/\n\s*\n/)) {
    const rows = block
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
    const timeIdx = rows.findIndex((r) => r.includes("-->"));
    if (timeIdx < 0) continue;
    const [left = "", right = ""] = rows[timeIdx]!.split("-->");
    const start = srtSeconds(left);
    const end = srtSeconds(right.trim().split(/\s+/)[0] ?? "");
    if (start === undefined || end === undefined) continue;
    const text = rows
      .slice(timeIdx + 1)
      .map(stripMarkup)
      .filter(Boolean)
      .join(" ");
    if (!text) continue;
    lines.push({ startTime: round3(start), endTime: round3(Math.max(end, start)), text });
  }
  lines.sort((a, b) => a.startTime! - b.startTime!);
  return { format: "srt", meta: {}, lines };
}

/** Plain text: one lyric line per non-empty line, untimed. */
export function parsePlainLyrics(raw: string): ParsedLyrics {
  const lines = normalizeNewlines(raw)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((text) => ({ startTime: null, endTime: null, text }));
  return { format: "txt", meta: {}, lines };
}

/** Parse lyrics in any supported format (auto-detected unless given). */
export function parseLyrics(raw: string, format: LyricsSourceFormat = detectLyricsFormat(raw), opts?: LrcParseOptions): ParsedLyrics {
  if (format === "srt") return parseSrt(raw);
  if (format === "lrc") return parseLrc(raw, opts);
  return parsePlainLyrics(raw);
}
