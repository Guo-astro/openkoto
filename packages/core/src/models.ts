// Sync payload shapes. Mirrors the Codable JSON of iOS OKModels (Models.swift, Book.swift):
// camelCase keys, ISO-8601 UTC date strings, lowercase UUID strings on the wire.
// Swift optionals are omitted when nil; readers should also accept `null`.
// Unknown fields must be preserved by clients (sync-protocol-spec §2.2).

import type { JsonObject, RecordType } from "./protocol";

/** ISO-8601 UTC timestamp, e.g. "2026-09-28T10:00:00Z". */
export type IsoDateTime = string;
/** Local calendar date "YYYY-MM-DD". */
export type LocalDate = string;

export type SrsState = "new" | "learning" | "review";

/** Known values plus forward-compatible unknown strings. */
export type SourceType = "article" | "web" | "lyrics" | (string & {});

export interface FavoriteVocabulary {
  id: string;
  word: string;
  meaning: string;
  usage?: string | null;
  explanation?: string | null;
  example?: string | null;
  reading?: string | null;
  sourceArticleId?: string | null;
  sourceArticleTitle?: string | null;
  sourceSegmentId?: string | null;
  /** Local convenience; membership is synced as WordPackMembership records. */
  packIds?: string[];
  srsState: SrsState;
  /** 0 = uninitialised (new card). */
  stability: number;
  /** [1, 10]; 0 = uninitialised. */
  difficulty: number;
  schedulerVersion?: string | null;
  suspendedAt?: IsoDateTime | null;
  dueDate: LocalDate;
  lastReviewedAt?: IsoDateTime | null;
  reviewCount: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface WordPack {
  id: string;
  name: string;
  packDescription?: string | null;
  coverURL?: string | null;
  author?: string | null;
  languageFrom?: string | null;
  languageTo?: string | null;
  tags: string[];
  version?: string | null;
  isSystem: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** Record id is `<vocabularyId>_<packId>`. */
export interface WordPackMembership {
  vocabularyId: string;
  packId: string;
  createdAt?: IsoDateTime;
}

export interface ReviewEvent {
  id: string;
  vocabularyId: string;
  reviewedAt: IsoDateTime;
  dateLocal: LocalDate;
  /** 1=Again 2=Hard 3=Good 4=Easy; 0 for a void marker. */
  grade: number;
  elapsedDays: number;
  previousState: SrsState;
  schedulerVersion: string;
  desiredRetention: number;
  resultStability: number;
  resultDifficulty: number;
  resultIntervalDays: number;
  resultState: SrsState;
  /** Set on an undo event: the id of the event it cancels. */
  voidsEventId?: string | null;
}

export interface Article {
  id: string;
  title: string;
  content: string;
  sourceType?: SourceType | null;
  sourceURL?: string | null;
  createdAt: IsoDateTime;
}

export interface VocabularyItem {
  word: string;
  meaning: string;
  usage?: string | null;
  example?: string | null;
  reading?: string | null;
}

export interface GrammarPoint {
  point: string;
  explanation: string;
  example?: string | null;
}

export type DifficultyLevel = "beginner" | "intermediate" | "advanced";

export interface SegmentExplanation {
  translation: string;
  explanation: string;
  readingText?: string | null;
  vocabulary: VocabularyItem[];
  grammarPoints: GrammarPoint[];
  culturalContext?: string | null;
  difficultyLevel?: DifficultyLevel | (string & {}) | null;
  learningTips?: string | null;
}

export interface ArticleSegment {
  id: string;
  articleId: string;
  order: number;
  text: string;
  readingText?: string | null;
  translation?: string | null;
  explanation?: SegmentExplanation | null;
  isNewParagraph: boolean;
  /** Seconds; only media transcripts and timed lyrics carry times. */
  startTime?: number | null;
  endTime?: number | null;
  createdAt: IsoDateTime;
  /** Bumped on re-segmentation (sync-protocol-spec §4.3); missing = 0. */
  segmentationRevision?: number;
}

export type BookFormat = "txt" | "epub";
export type BookRenderMode = "native" | "original";

export interface Book {
  id: string;
  title: string;
  author?: string | null;
  language?: string | null;
  format: BookFormat;
  dirName?: string;
  opfPath?: string | null;
  coverHref?: string | null;
  totalChars: number;
  defaultMode: BookRenderMode;
  originalOnly: boolean;
  createdAt: IsoDateTime;
  fileSha256?: string | null;
  fileSize?: number | null;
}

/** Record id = articleId (a chapter is an Article row). */
export interface BookChapter {
  articleId: string;
  bookId: string;
  index: number;
  sourceHref?: string | null;
  isSegmented: boolean;
  charCount: number;
}

/** One per book; record id = bookId. */
export interface BookProgress {
  bookId: string;
  chapterArticleId?: string | null;
  chapterIndex: number;
  segmentOrder?: number | null;
  scrollFraction?: number | null;
  mode: BookRenderMode;
  updatedAt: IsoDateTime;
}

export type BookMarkKind = "bookmark" | "highlight";

export interface BookMark {
  id: string;
  bookId: string;
  chapterArticleId?: string | null;
  chapterIndex: number;
  kind: BookMarkKind;
  segmentOrder?: number | null;
  charStart?: number | null;
  charEnd?: number | null;
  locator?: string | null;
  scrollFraction?: number | null;
  selectedText?: string | null;
  note?: string | null;
  color?: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type LyricsSourceFormat = "lrc" | "txt" | "srt";

/** Record id = articleId of the lyrics Article (sourceType "lyrics"). */
export interface LyricsMeta {
  articleId: string;
  artist?: string | null;
  album?: string | null;
  language?: string | null;
  lrcOffsetMs?: number | null;
  sourceFormat?: LyricsSourceFormat | null;
  coverUrl?: string | null;
  /** External links only; audio is never stored. */
  musicLinks?: string[] | null;
}

export interface PayloadMap {
  Vocabulary: FavoriteVocabulary;
  WordPack: WordPack;
  WordPackMembership: WordPackMembership;
  ReviewEvent: ReviewEvent;
  Article: Article;
  Segment: ArticleSegment;
  Book: Book;
  BookChapter: BookChapter;
  BookMark: BookMark;
  BookProgress: BookProgress;
  LyricsMeta: LyricsMeta;
}

/** Payload type for a record type; types without a model yet are plain JSON objects. */
export type PayloadOf<T extends RecordType> = T extends keyof PayloadMap ? PayloadMap[T] : JsonObject;

export function membershipId(vocabularyId: string, packId: string): string {
  return `${vocabularyId.toLowerCase()}_${packId.toLowerCase()}`;
}

export function parseMembershipId(id: string): { vocabularyId: string; packId: string } | null {
  const i = id.indexOf("_");
  if (i <= 0 || i === id.length - 1) return null;
  return { vocabularyId: id.slice(0, i), packId: id.slice(i + 1) };
}
