// Minimal RFC 4180 CSV reader for `koto vocab import`.

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  const delimiter = detectDelimiter(src);
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  return first.includes("\t") && !first.includes(",") ? "\t" : ",";
}

const COLUMN_ALIASES: Record<string, string> = {
  word: "word",
  term: "word",
  front: "word",
  单词: "word",
  単語: "word",
  meaning: "meaning",
  definition: "meaning",
  back: "meaning",
  translation: "meaning",
  释义: "meaning",
  意味: "meaning",
  reading: "reading",
  pronunciation: "reading",
  读音: "reading",
  読み: "reading",
  example: "example",
  sentence: "example",
  例句: "example",
  例文: "example",
  usage: "usage",
  pack: "pack",
  deck: "pack",
};

export interface CsvVocabRow {
  word: string;
  meaning?: string;
  reading?: string;
  example?: string;
  usage?: string;
  pack?: string;
}

/** Header row is optional; without one columns are word, meaning, reading, example. */
export function csvToVocab(text: string): CsvVocabRow[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0]!.map((h) => COLUMN_ALIASES[h.trim().toLowerCase()] ?? null);
  const hasHeader = header.includes("word");
  const columns = hasHeader ? header : ["word", "meaning", "reading", "example"];
  return rows.slice(hasHeader ? 1 : 0).flatMap((cells) => {
    const out: Record<string, string> = {};
    columns.forEach((col, i) => {
      const value = cells[i]?.trim();
      if (col && value) out[col] = value;
    });
    return out.word ? [out as unknown as CsvVocabRow] : [];
  });
}
