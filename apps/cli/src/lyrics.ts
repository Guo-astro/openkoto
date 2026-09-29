// Lyrics rendering helpers (bilingual LRC / text / Markdown).

import { toLrc, type LyricLine, type LyricsMetaTags } from "@openkoto/core";

export interface TranslatedLine {
  startTime: number | null;
  endTime: number | null;
  text: string;
  translation: string | null;
}

export function mergeTranslations(lines: readonly LyricLine[], translations: readonly (string | null | undefined)[]): TranslatedLine[] {
  return lines.map((l, i) => ({ startTime: l.startTime, endTime: l.endTime, text: l.text, translation: translations[i] || null }));
}

/**
 * Bilingual LRC: each timed line is followed by its translation carrying the same
 * timestamp (the convention most players render as a second line). Untimed lyrics
 * become original/translation line pairs.
 */
export function toBilingualLrc(lines: readonly TranslatedLine[], meta: LyricsMetaTags = {}, opts: { translationOnly?: boolean } = {}): string {
  const out: LyricLine[] = [];
  for (const line of lines) {
    const hasTranslation = !!line.translation && line.translation !== line.text;
    if (!opts.translationOnly || !hasTranslation) {
      out.push({ startTime: line.startTime, endTime: hasTranslation ? null : line.endTime, text: line.text });
    }
    if (hasTranslation) out.push({ startTime: line.startTime, endTime: line.endTime, text: line.translation! });
  }
  return toLrc({ lines: out, meta });
}

export function toMarkdown(title: string, lines: readonly TranslatedLine[], meta: { artist?: string | null } = {}): string {
  const out = [`# ${title}`];
  if (meta.artist) out.push("", `*${meta.artist}*`);
  out.push("");
  for (const line of lines) {
    out.push(line.translation ? `${line.text}  \n${line.translation}` : line.text, "");
  }
  return out.join("\n").replace(/\n+$/, "\n");
}
