// `koto book import`: parse locally, upload the original file, then push Book / Article /
// BookChapter records through the sync protocol (same record shapes as the web import).

import { createHash, randomUUID } from "node:crypto";
import { HybridClock, MAX_PUSH_OPS, nodeIdFromDevice, type JsonObject, type PushOp, type RecordType } from "@openkoto/core";
import type { FetchLike, OpenKotoClient, TokenStore } from "@openkoto/client";
import { parseBook, type ParsedBook } from "./books";
import { CliError, EXIT, notLoggedIn } from "./errors";

const PUSH_BYTE_BUDGET = 3 * 1024 * 1024;

export interface ImportBookDeps {
  client: OpenKotoClient;
  tokenStore: TokenStore;
  fetch: FetchLike;
  now?: () => number;
  onProgress?: (message: string) => void;
}

export interface ImportedBook {
  bookId: string;
  title: string;
  author: string | null;
  format: "epub" | "txt";
  chapters: number;
  totalChars: number;
  fileSize: number;
  sha256: string;
}

/** Bearer request outside the JSON client (binary upload), with one refresh on 401. */
async function authedFetch(deps: ImportBookDeps, url: string, init: RequestInit): Promise<Response> {
  let tokens = await deps.tokenStore.get();
  if (!tokens?.accessToken) throw notLoggedIn();
  const now = (deps.now ?? Date.now)();
  if (tokens.refreshToken && typeof tokens.expiresAt === "number" && now >= tokens.expiresAt - 30_000) tokens = await deps.client.refresh();
  const send = (token: string) => deps.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
  let res = await send(tokens.accessToken);
  if (res.status === 401 && tokens.refreshToken) res = await send((await deps.client.refresh()).accessToken);
  return res;
}

async function apiError(res: Response): Promise<CliError> {
  let code = `HTTP_${res.status}`;
  let message = res.statusText || code;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // non-JSON
  }
  if (res.status === 401) return new CliError(EXIT.NOT_LOGGED_IN, code, `${message}. Run \`koto login\` again.`);
  if (res.status === 402) return new CliError(EXIT.PLAN, code, `${message}. Upgrade at https://openkoto.app/pricing`);
  return new CliError(EXIT.ERROR, code, `${message} (HTTP ${res.status})`);
}

function batches(ops: PushOp[]): PushOp[][] {
  const out: PushOp[][] = [];
  let current: PushOp[] = [];
  let bytes = 0;
  for (const op of ops) {
    const size = JSON.stringify(op).length * 3; // worst case UTF-8
    if (current.length && (current.length >= MAX_PUSH_OPS || bytes + size > PUSH_BYTE_BUDGET)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(op);
    bytes += size;
  }
  if (current.length) out.push(current);
  return out;
}

export function bookRecords(parsed: ParsedBook, bookId: string, sha256: string, fileSize: number, createdAt: string) {
  const totalChars = parsed.chapters.reduce((n, c) => n + c.text.length, 0);
  const records: { type: RecordType; id: string; payload: JsonObject }[] = [
    {
      type: "Book",
      id: bookId,
      payload: {
        id: bookId,
        title: parsed.title,
        author: parsed.author,
        language: parsed.language,
        format: parsed.format,
        dirName: bookId,
        totalChars,
        defaultMode: "native",
        originalOnly: false,
        createdAt,
        fileSha256: sha256,
        fileSize,
      },
    },
  ];
  parsed.chapters.forEach((ch, index) => {
    const articleId = randomUUID();
    records.push({ type: "Article", id: articleId, payload: { id: articleId, title: ch.title, content: ch.text, sourceType: "book", createdAt } });
    records.push({ type: "BookChapter", id: articleId, payload: { articleId, bookId, index, title: ch.title, isSegmented: false, charCount: ch.text.length } });
  });
  return { records, totalChars };
}

export async function importBook(deps: ImportBookDeps, bytes: Uint8Array, fileName: string): Promise<ImportedBook> {
  const parsed = parseBook(bytes, fileName);
  const ext = parsed.format;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const bookId = randomUUID();
  deps.onProgress?.(`Parsed "${parsed.title}": ${parsed.chapters.length} chapters. Uploading…`);

  const upload = await authedFetch(deps, deps.client.url(`/api/v1/books/${bookId}/file`, { ext, sha256 }), {
    method: "PUT",
    body: bytes as unknown as BodyInit,
    headers: { "Content-Type": ext === "epub" ? "application/epub+zip" : "text/plain; charset=utf-8", "Content-Length": String(bytes.byteLength) },
  });
  if (!upload.ok) throw await apiError(upload);

  const tokens = await deps.tokenStore.get();
  const deviceId = tokens?.deviceId ?? "cli";
  const clock = new HybridClock(nodeIdFromDevice(tokens?.deviceId ?? randomUUID()), null, deps.now);
  const createdAt = new Date((deps.now ?? Date.now)()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const { records, totalChars } = bookRecords(parsed, bookId, sha256, bytes.byteLength, createdAt);
  const ops: PushOp[] = records.map((r) => ({ opId: randomUUID(), type: r.type, id: r.id, baseRev: 0, hlc: clock.tick(), deleted: false, payload: r.payload }));

  // Book first: if the plan's book quota rejects it, nothing else is written.
  const all = [ops.slice(0, 1), ...batches(ops.slice(1))];
  let done = 0;
  for (const batch of all) {
    const res = await deps.client.sync.push({ deviceId, ops: batch });
    const rejected = res.results.find((r) => r.status === "rejected");
    if (rejected && rejected.status === "rejected") {
      if (rejected.code === "QUOTA_EXCEEDED") throw new CliError(EXIT.PLAN, "QUOTA_EXCEEDED", `${rejected.message ?? "plan quota exceeded"}. Upgrade at https://openkoto.app/pricing`);
      throw new CliError(EXIT.ERROR, rejected.code, rejected.message ?? `sync push rejected: ${rejected.code}`);
    }
    done += batch.length;
    deps.onProgress?.(`Synced ${done}/${ops.length} records`);
  }
  return { bookId, title: parsed.title, author: parsed.author, format: parsed.format, chapters: parsed.chapters.length, totalChars, fileSize: bytes.byteLength, sha256 };
}
