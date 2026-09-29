// Reading progress synced as BookProgress (src-tauri: get/save/migrate_book_progress_cmd).
import { invoke } from "@tauri-apps/api/core";

export interface BookProgress {
  book_id: string;
  chapter_index: number;
  locator?: string | null;
  page_number?: number | null;
  updated_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIGRATED_KEY = "openkoto.bookProgressMigrated.v1";

/** `…/book/<id>.<ext>` (reader URL or local path) → book id, or null for non-book files. */
export function bookIdFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // keep raw
  }
  const file = decoded.split(/[/\\]/).pop() ?? "";
  const stem = file.split(".")[0] ?? "";
  return UUID_RE.test(stem) ? stem.toLowerCase() : null;
}

export async function getBookProgress(bookId: string | null): Promise<BookProgress | null> {
  if (!bookId) return null;
  try {
    return (await invoke<BookProgress | null>("get_book_progress_cmd", { bookId })) ?? null;
  } catch {
    return null;
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounced (1.5 s) save; the backend marks it for sync. */
export function saveBookProgress(
  bookId: string | null,
  update: { locator?: string | null; pageNumber?: number | null; chapterIndex?: number | null },
): void {
  if (!bookId) return;
  const existing = timers.get(bookId);
  if (existing) clearTimeout(existing);
  timers.set(
    bookId,
    setTimeout(() => {
      timers.delete(bookId);
      invoke("save_book_progress_cmd", {
        bookId,
        locator: update.locator ?? null,
        pageNumber: update.pageNumber ?? null,
        chapterIndex: update.chapterIndex ?? null,
      }).catch((e) => console.warn("Failed to save reading progress:", e));
    }, 1500),
  );
}

/** One-time: move `epub-location-*` / `pdf-page-*` from localStorage into book_progress. */
export async function migrateLegacyBookProgress(storage: Storage = window.localStorage): Promise<number> {
  try {
    if (storage.getItem(MIGRATED_KEY)) return 0;
    const entries: { key: string; value: string }[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key || !(key.startsWith("epub-location-") || key.startsWith("pdf-page-"))) continue;
      const value = storage.getItem(key);
      if (value) entries.push({ key, value });
    }
    const imported = entries.length ? await invoke<number>("migrate_book_progress_cmd", { entries }) : 0;
    storage.setItem(MIGRATED_KEY, new Date().toISOString());
    return imported ?? 0;
  } catch (e) {
    console.warn("Book progress migration failed:", e);
    return 0;
  }
}
