import { describe, expect, it } from "vitest";
import { contentLang, getDoc, getLegal, listDocs, listUpdates, parseFrontmatter } from "../content";

describe("public content", () => {
  it("parses frontmatter", () => {
    const { data, body } = parseFrontmatter('---\ntitle: "Hi: there"\ndate: 2026-01-01\n---\n\n# Body');
    expect(data).toEqual({ title: "Hi: there", date: "2026-01-01" });
    expect(body.trim()).toBe("# Body");
  });

  it("maps UI languages to content languages", () => {
    expect(contentLang("zh-CN")).toBe("zh");
    expect(contentLang("ja")).toBe("ja");
    expect(contentLang("fr")).toBe("en");
  });

  it("has every doc, update and legal page in en, zh and ja", () => {
    for (const lang of ["en", "zh", "ja"] as const) {
      const docs = listDocs(lang);
      expect(docs.map((d) => d.slug)).toEqual(["index", "google-ai-studio", "302ai", "kimi-k2"]);
      expect(docs.every((d) => d.lang === lang)).toBe(true);
      expect(listUpdates(lang).every((u) => u.lang === lang)).toBe(true);
      expect(getLegal("privacy", lang)?.lang).toBe(lang);
      expect(getLegal("terms", lang)?.lang).toBe(lang);
    }
  });

  it("orders the changelog newest first", () => {
    const dates = listUpdates("en").map((u) => u.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it("only references images that exist under /docs and no legacy language-prefixed links", async () => {
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const lang of ["en", "zh", "ja"] as const) {
      for (const d of listDocs(lang)) {
        expect(d.body).not.toMatch(/\]\(\/(en|zh|ja)\//);
        for (const [, src] of d.body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
          expect(src).toMatch(/^\/docs\//);
          expect(existsSync(resolve(__dirname, "../../../public", `.${src}`))).toBe(true);
        }
      }
    }
    expect(getDoc("missing", "en")).toBeUndefined();
  });
});
