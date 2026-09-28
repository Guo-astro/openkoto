import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { bookIdFromPath, migrateLegacyBookProgress } from "./bookProgress";

describe("bookProgress", () => {
  afterEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
  });

  it("extracts book ids from reader URLs", () => {
    expect(bookIdFromPath("http://127.0.0.1:19420/book/0B8E2C1A-5D4F-4E3A-9B2C-1D0E9F8A7B99.epub")).toBe(
      "0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b99",
    );
    expect(bookIdFromPath("/books/0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b99.chapters.txt")).toBe("0b8e2c1a-5d4f-4e3a-9b2c-1d0e9f8a7b99");
    expect(bookIdFromPath("http://127.0.0.1:19420/book/mono.pdf")).toBeNull();
    expect(bookIdFromPath(undefined)).toBeNull();
  });

  it("migrates legacy localStorage progress once", async () => {
    localStorage.setItem("epub-location-http://127.0.0.1:19420/book/a.epub", "epubcfi(/6/2)");
    localStorage.setItem("pdf-page-http://127.0.0.1:19420/book/b.pdf", "12");
    localStorage.setItem("unrelated", "x");
    invokeMock.mockResolvedValue(2);

    expect(await migrateLegacyBookProgress()).toBe(2);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0]!;
    expect(command).toBe("migrate_book_progress_cmd");
    expect((args as { entries: unknown[] }).entries).toHaveLength(2);

    expect(await migrateLegacyBookProgress()).toBe(0);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
