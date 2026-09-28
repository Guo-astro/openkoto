// Typed wrapper around the high-level REST API: /api/v1/library (server/worker/src/library/routes.ts),
// hosted AI (/api/v1/ai) and background jobs (/api/v1/jobs).
// Shared by the koto CLI, the stdio MCP server and the Worker's remote MCP endpoint.

import type { OpenKotoClient } from "./api";
import type { ExtractedVocab, Article, ArticleSegment, FavoriteVocabulary, LyricsMeta, LyricsSourceFormat, ReviewEvent, WordPack } from "@openkoto/core";

const BASE = "/api/v1/library";

export type Vocab = FavoriteVocabulary & { packIds?: string[] };
export interface Page<T> {
  items: T[];
  total: number;
}
export type ArticleSummary = Omit<Article, "content"> & { preview: string; length: number };
export type LyricsSummary = ArticleSummary & { artist: string | null; language: string | null };
export interface LyricsDetail {
  article: Article;
  segments: ArticleSegment[];
  meta: LyricsMeta | null;
}
export interface ArticleDetail {
  article: Article;
  segments: ArticleSegment[];
}
export interface BookSummary {
  id: string;
  title: string;
  author?: string | null;
  language?: string | null;
  format?: string;
  totalChars?: number;
  createdAt?: string;
  [key: string]: unknown;
}
export interface ChapterSummary {
  articleId: string;
  bookId: string;
  index: number;
  title: string | null;
  charCount?: number;
  isSegmented?: boolean;
}
export interface SearchHit {
  kind: "book" | "article" | "lyrics" | "vocab";
  id: string;
  title: string;
  subtitle?: string | null;
}

export interface AddVocabInput {
  word: string;
  meaning?: string;
  reading?: string;
  example?: string;
  usage?: string;
  explanation?: string;
  sourceArticleId?: string;
  sourceArticleTitle?: string;
  pack?: string | string[];
  tz?: string;
}

export interface CreateLyricsInput {
  title?: string;
  artist?: string;
  album?: string;
  language?: string;
  raw: string;
  format?: LyricsSourceFormat;
  translations?: string[];
}

function localTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

const enc = encodeURIComponent;

export class LibraryClient {
  constructor(
    private readonly client: Pick<OpenKotoClient, "request">,
    private readonly timeZone: string | undefined = localTimeZone(),
  ) {}

  // ---- vocabulary ----
  listVocab(opts: { due?: boolean; limit?: number; offset?: number; pack?: string; q?: string } = {}): Promise<Page<Vocab> & { date?: string }> {
    return this.client.request("GET", `${BASE}/vocab`, {
      query: { due: opts.due ? 1 : undefined, limit: opts.limit, offset: opts.offset, pack: opts.pack, q: opts.q, tz: this.timeZone },
    });
  }

  getVocab(id: string): Promise<{ vocab: Vocab }> {
    return this.client.request("GET", `${BASE}/vocab/${enc(id)}`);
  }

  addVocab(input: AddVocabInput): Promise<{ vocab: Vocab; created: boolean; deduped: boolean }> {
    return this.client.request("POST", `${BASE}/vocab`, { body: { tz: this.timeZone, ...input } });
  }

  updateVocab(id: string, patch: Partial<AddVocabInput> & { suspended?: boolean }): Promise<{ vocab: Vocab }> {
    return this.client.request("PATCH", `${BASE}/vocab/${enc(id)}`, { body: patch });
  }

  deleteVocab(id: string): Promise<{ ok: true; id: string }> {
    return this.client.request("DELETE", `${BASE}/vocab/${enc(id)}`);
  }

  reviewVocab(id: string, grade: number): Promise<{ vocab: Vocab; event: ReviewEvent }> {
    return this.client.request("POST", `${BASE}/vocab/${enc(id)}/review`, { body: { grade, tz: this.timeZone } });
  }

  // ---- packs ----
  listPacks(): Promise<Page<WordPack & { vocabCount: number }>> {
    return this.client.request("GET", `${BASE}/packs`);
  }

  createPack(input: { name: string; description?: string; languageFrom?: string; languageTo?: string; tags?: string[] }): Promise<{ pack: WordPack; created: boolean }> {
    return this.client.request("POST", `${BASE}/packs`, { body: input });
  }

  addPackMembers(packId: string, vocabularyIds: string[]): Promise<{ ok: true; packId: string; added: number }> {
    return this.client.request("POST", `${BASE}/packs/${enc(packId)}/members`, { body: { vocabularyIds } });
  }

  // ---- lyrics ----
  listLyrics(opts: { limit?: number; offset?: number } = {}): Promise<Page<LyricsSummary>> {
    return this.client.request("GET", `${BASE}/lyrics`, { query: opts });
  }

  getLyrics(id: string): Promise<LyricsDetail> {
    return this.client.request("GET", `${BASE}/lyrics/${enc(id)}`);
  }

  createLyrics(input: CreateLyricsInput): Promise<{ article: Article; meta: LyricsMeta; segments: ArticleSegment[] }> {
    return this.client.request("POST", `${BASE}/lyrics`, { body: input });
  }

  saveLyricsTranslations(id: string, translations: { order: number; translation: string }[]): Promise<{ ok: true; updated: number; total: number }> {
    return this.client.request("PUT", `${BASE}/lyrics/${enc(id)}/translations`, { body: { translations } });
  }

  // ---- articles ----
  listArticles(opts: { limit?: number; offset?: number } = {}): Promise<Page<ArticleSummary>> {
    return this.client.request("GET", `${BASE}/articles`, { query: opts });
  }

  getArticle(id: string): Promise<ArticleDetail> {
    return this.client.request("GET", `${BASE}/articles/${enc(id)}`);
  }

  createArticle(input: { title: string; content: string; sourceURL?: string }): Promise<ArticleDetail> {
    return this.client.request("POST", `${BASE}/articles`, { body: input });
  }

  // ---- books ----
  listBooks(): Promise<Page<BookSummary>> {
    return this.client.request("GET", `${BASE}/books`);
  }

  listChapters(bookId: string): Promise<Page<ChapterSummary> & { book: BookSummary }> {
    return this.client.request("GET", `${BASE}/books/${enc(bookId)}/chapters`);
  }

  // ---- search ----
  search(q: string, opts: { types?: string[]; limit?: number } = {}): Promise<Page<SearchHit>> {
    return this.client.request("GET", `${BASE}/search`, { query: { q, types: opts.types?.join(","), limit: opts.limit } });
  }

  // ---- hosted AI (metered, needs credits) ----
  translateLyricsHosted(input: { lines: string[]; targetLanguage: string; title?: string; artist?: string }): Promise<{ translations: string[]; aligned?: boolean; credits?: number; cached?: boolean }> {
    return this.client.request("POST", "/api/v1/ai/translate-lyrics", { body: input });
  }

  extractVocabHosted(input: { text: string; targetLanguage: string; max?: number; level?: string }): Promise<{ items: ExtractedVocab[]; credits: number; cached: boolean }> {
    return this.client.request("POST", "/api/v1/ai/extract-vocab", { body: input });
  }

  // ---- background jobs ----
  createTranslateBookJob(input: { bookId: string; targetLanguage: string; chapters?: string[] }): Promise<{ id: string; status: string; total: number }> {
    return this.client.request("POST", "/api/v1/jobs", { body: { kind: "translate_book", ...input } });
  }

  listJobs(): Promise<{ jobs: Job[] }> {
    return this.client.request("GET", "/api/v1/jobs");
  }

  getJob(id: string): Promise<Job> {
    return this.client.request("GET", `/api/v1/jobs/${enc(id)}`);
  }

  cancelJob(id: string): Promise<{ ok: true }> {
    return this.client.request("POST", `/api/v1/jobs/${enc(id)}/cancel`, { body: {} });
  }
}

export interface Job {
  id: string;
  kind: string;
  status: "queued" | "running" | "paused" | "done" | "failed" | "canceled" | (string & {});
  progress: number;
  total: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
