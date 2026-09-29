// Sentence segmentation. Port of the desktop splitter
// (textlingo-desktop/src-tauri/src/commands.rs: create_segments_from_content /
// split_into_sentences / is_abbreviation) via iOS OKSegmentation.SentenceSegmenter.
// All clients must produce identical boundaries, otherwise synced translations and
// explanations drift. Iterates Unicode scalars (code points), like Rust `Vec<char>`.

export interface SegmentDraft {
  text: string;
  isNewParagraph: boolean;
}

const SENTENCE_END = new Set([".", "。", "？", "！", "?", "!"]);
// Closing marks absorbed into the preceding sentence. Includes U+201D like iOS
// (the Rust source compares ASCII '"' twice, see report).
const CLOSERS = new Set(['"', "”", "'", "’", ")", "）"]);
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "jr", "sr", "vs", "etc", "inc", "ltd", "no", "st", "ave", "rd"]);

const ALPHA = /^\p{Alphabetic}$/u;
const UPPER = /^\p{Uppercase}$/u;

/** Split `text` into sentences, marking the first sentence of each paragraph. */
export function segmentText(text: string): SegmentDraft[] {
  const drafts: SegmentDraft[] = [];
  for (const paragraph of splitParagraphs(text)) {
    splitIntoSentences(paragraph).forEach((sentence, index) => {
      const trimmed = sentence.trim();
      if (trimmed) drafts.push({ text: trimmed, isNewParagraph: index === 0 });
    });
  }
  return drafts;
}

/** Split on "\n", trim, drop empty lines. */
export function splitParagraphs(text: string): string[] {
  return text
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Split one paragraph into sentences, keeping terminal punctuation. */
export function splitIntoSentences(text: string): string[] {
  const chars = Array.from(text);
  const sentences: string[] = [];
  let current = "";

  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    current += c;
    const isEnd = SENTENCE_END.has(c) && (c !== "." || !isAbbreviation(chars, i));
    if (!isEnd) continue;

    const next = chars[i + 1];
    if (next !== undefined && CLOSERS.has(next)) {
      current += next;
      i++;
    }
    const trimmed = current.trim();
    if (trimmed) sentences.push(trimmed);
    current = "";
  }

  const trailing = current.trim();
  if (trailing) sentences.push(trailing);
  const whole = text.trim();
  if (sentences.length === 0 && whole) sentences.push(whole);
  return sentences;
}

/** Heuristic: is the "." at `pos` part of an abbreviation (Mr., U.S.A, A. B.)? */
export function isAbbreviation(chars: readonly string[], pos: number): boolean {
  const next = chars[pos + 1];
  if (next !== undefined && ALPHA.test(next)) return true;

  const word: string[] = [];
  for (let j = pos - 1; j >= 0 && ALPHA.test(chars[j]!); j--) word.unshift(chars[j]!);
  if (ABBREVIATIONS.has(word.join("").toLowerCase())) return true;
  return word.length === 1 && UPPER.test(word[0]!);
}
