import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { parseChapterRanges, parseEpub, parseTxt, xhtmlToText } from "../src/books";

const BASE = "https://koto.test";
const ME_PLUS = { user: { id: "u1", email: "a@b.c" }, plan: "plus", entitlements: { sync: true, cli: true, apiKeys: true, hostedAi: true }, credits: 10 };

function epub(): Uint8Array {
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(
      '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    "OEBPS/content.opf": strToU8(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>吾輩は猫である</dc:title><dc:creator>夏目 漱石</dc:creator><dc:language>ja</dc:language>
  </metadata>
  <manifest>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="cover.jpg" media-type="image/jpeg"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="img"/><itemref idref="c2"/></spine>
</package>`),
    "OEBPS/text/ch1.xhtml": strToU8(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t1</title><style>p{}</style></head><body><h1>一</h1><p>吾輩は<ruby>猫<rt>ねこ</rt></ruby>である。</p><p>名前はまだ&#x7121;い。&amp;</p></body></html>',
    ),
    "OEBPS/text/ch2.xhtml": strToU8('<html><head><title>Two</title></head><body><div>Second<br/>line</div></body></html>'),
  });
}

describe("book parsing", () => {
  it("parses EPUB metadata, spine order and ruby-free text", () => {
    const book = parseEpub(epub(), "neko.epub");
    expect(book).toMatchObject({ title: "吾輩は猫である", author: "夏目 漱石", language: "ja", format: "epub" });
    expect(book.chapters).toEqual([
      { title: "一", text: "一\n吾輩は猫である。\n名前はまだ無い。&" },
      { title: "Two", text: "Second\nline" },
    ]);
  });

  it("splits TXT novels on chapter headings", () => {
    const book = parseTxt(new TextEncoder().encode("前言\n第一章 开始\n内容一\n第二章 继续\n内容二\n"), "/x/小说.txt");
    expect(book.title).toBe("小说");
    expect(book.chapters.map((c) => c.title)).toEqual(["小说", "第一章 开始", "第二章 继续"]);
    expect(book.chapters[1]!.text).toBe("内容一");
  });

  it("strips markup", () => {
    expect(xhtmlToText("<body><p>a <b>b</b></p><script>x</script><p>c&lt;d</p></body>")).toBe("a b\nc<d");
  });

  it("parses chapter ranges", () => {
    expect(parseChapterRanges("1-3,5, 2", 10)).toEqual([0, 1, 2, 4]);
    expect(parseChapterRanges("9-", 10)).toEqual([8, 9]);
    expect(parseChapterRanges("8-20", 10)).toEqual([7, 8, 9]);
    expect(() => parseChapterRanges("x", 10)).toThrow();
  });
});

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
  rawBody?: unknown;
}

let dir: string;
let calls: Call[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "koto-books-"));
  calls = [];
  await writeFile(join(dir, "credentials.json"), JSON.stringify({ accessToken: "at1", refreshToken: "rt1", expiresAt: Date.now() + 3_600_000, deviceId: "0f1e2d3c-aaaa-bbbb-cccc-000000000000", baseUrl: BASE }));
});

function res(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function run(argv: string[], handler: (c: Call) => Response | undefined) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    env: { KOTO_CONFIG_DIR: dir, KOTO_API_BASE: BASE },
    fetch: async (input, init = {}) => {
      const isJson = typeof init.body === "string";
      const call: Call = { method: init.method ?? "GET", url: new URL(input), headers: (init.headers ?? {}) as Record<string, string>, body: isJson ? JSON.parse(init.body as string) : undefined, rawBody: isJson ? undefined : init.body };
      calls.push(call);
      if (call.url.pathname === "/api/v1/me") return res(200, ME_PLUS);
      const r = handler(call);
      if (!r) throw new Error(`unexpected ${call.method} ${input}`);
      return r;
    },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    openBrowser: async () => false,
    readKey: null,
    sleep: async () => {},
  });
  return { code, stdout: out.join(""), stderr: err.join(""), json: () => JSON.parse(out.join("")) };
}

describe("koto book import", () => {
  it("uploads the file and pushes Book, Article and BookChapter records", async () => {
    const file = join(dir, "neko.epub");
    const bytes = epub();
    await writeFile(file, bytes);
    const r = await run(["book", "import", file, "--json"], (c) => {
      if (c.method === "PUT" && /^\/api\/v1\/books\/[0-9a-f-]{36}\/file$/.test(c.url.pathname)) return res(200, { ok: true });
      if (c.url.pathname === "/api/v1/sync/push") return res(200, { results: c.body.ops.map((o: { opId: string }, i: number) => ({ opId: o.opId, status: "applied", rev: i + 1 })), cursor: "c_1" });
      return undefined;
    });
    expect(r.code).toBe(0);
    const out = r.json();
    expect(out).toMatchObject({ title: "吾輩は猫である", author: "夏目 漱石", format: "epub", chapters: 2, fileSize: bytes.byteLength });

    const upload = calls.find((c) => c.method === "PUT")!;
    expect(upload.url.searchParams.get("ext")).toBe("epub");
    expect(upload.url.searchParams.get("sha256")).toBe(out.sha256);
    expect(upload.headers["Content-Length"]).toBe(String(bytes.byteLength));
    expect(upload.headers.Authorization).toBe("Bearer at1");

    const pushes = calls.filter((c) => c.url.pathname === "/api/v1/sync/push");
    expect(pushes[0]!.body.ops).toHaveLength(1);
    expect(pushes[0]!.body.ops[0]).toMatchObject({ type: "Book", id: out.bookId, baseRev: 0, deleted: false, payload: { title: "吾輩は猫である", format: "epub", fileSha256: out.sha256 } });
    const rest = pushes.slice(1).flatMap((p) => p.body.ops);
    expect(rest.map((o: { type: string }) => o.type)).toEqual(["Article", "BookChapter", "Article", "BookChapter"]);
    expect(rest[1].payload).toMatchObject({ bookId: out.bookId, index: 0, articleId: rest[0].id, isSegmented: false });
    expect(rest[0].payload).toMatchObject({ sourceType: "book", title: "一" });
    const hlcs = [pushes[0]!.body.ops[0].hlc, ...rest.map((o: { hlc: string }) => o.hlc)];
    expect([...hlcs].sort()).toEqual(hlcs);
    expect(hlcs[0]).toMatch(/-0f1e2d3c$/);
  });

  it("stops with exit 4 when the book quota rejects the Book record", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "hello");
    const r = await run(["book", "import", file], (c) => {
      if (c.method === "PUT") return res(200, { ok: true });
      if (c.url.pathname === "/api/v1/sync/push") return res(200, { results: [{ opId: c.body.ops[0].opId, status: "rejected", code: "QUOTA_EXCEEDED", message: "book limit reached" }], cursor: "c_0" });
      return undefined;
    });
    expect(r.code).toBe(4);
    expect(calls.filter((c) => c.url.pathname === "/api/v1/sync/push")).toHaveLength(1);
  });

  it("maps a 402 upload to exit 4", async () => {
    const file = join(dir, "a.txt");
    await writeFile(file, "hello");
    const r = await run(["book", "import", file], () => res(402, { error: { code: "QUOTA_EXCEEDED", message: "storage quota exceeded" } }));
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("storage quota exceeded");
  });
});

describe("book translate / jobs / keys", () => {
  const chapters = { book: { id: "b1", title: "Novel" }, items: [1, 2, 3, 4].map((n) => ({ articleId: `a${n}`, bookId: "b1", index: n - 1, title: `C${n}` })), total: 4 };

  it("creates a translate job for chapter ranges", async () => {
    const r = await run(["book", "translate", "b1", "--to", "zh", "--chapters", "2-3", "--json"], (c) => {
      if (c.url.pathname === "/api/v1/library/books/b1/chapters") return res(200, chapters);
      if (c.url.pathname === "/api/v1/jobs" && c.method === "POST") return res(202, { id: "j1", status: "queued", total: c.body.chapters.length });
      return undefined;
    });
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ id: "j1", status: "queued", total: 2 });
    expect(calls.find((c) => c.url.pathname === "/api/v1/jobs")!.body).toEqual({ kind: "translate_book", bookId: "b1", targetLanguage: "zh", chapters: ["a2", "a3"] });
  });

  it("watches a job until it finishes", async () => {
    const states = ["queued", "running", "done"];
    const r = await run(["job", "status", "j1", "--watch", "--json"], (c) =>
      c.url.pathname === "/api/v1/jobs/j1" ? res(200, { id: "j1", kind: "translate_book", status: states.shift() ?? "done", progress: 1, total: 2, error: null, createdAt: "", updatedAt: "" }) : undefined,
    );
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ id: "j1", status: "done" });
    expect(calls.filter((c) => c.url.pathname === "/api/v1/jobs/j1")).toHaveLength(3);
  });

  it("reports a job paused for credits with exit 4", async () => {
    const r = await run(["job", "status", "j1", "--watch"], () => res(200, { id: "j1", kind: "translate_book", status: "paused", progress: 1, total: 2, error: "INSUFFICIENT_CREDITS", createdAt: "", updatedAt: "" }));
    expect(r.code).toBe(4);
  });

  it("lists jobs", async () => {
    const r = await run(["job", "list", "--json"], (c) => (c.url.pathname === "/api/v1/jobs" ? res(200, { jobs: [] }) : undefined));
    expect(r.json()).toEqual({ jobs: [] });
  });

  it("creates, lists and revokes API keys", async () => {
    const created = await run(["keys", "create", "--name", "ci", "--scopes", "vocab:read,library:write", "--expires-days", "30", "--json"], (c) =>
      c.url.pathname === "/api/v1/keys" && c.method === "POST" ? res(201, { id: "k1", key: "ok_live_secret", prefix: "ok_live_secr", name: "ci", scopes: c.body.scopes, expiresAt: null }) : undefined,
    );
    expect(created.json()).toMatchObject({ key: "ok_live_secret", scopes: ["vocab:read", "library:write"] });
    expect(calls.at(-1)!.body).toEqual({ name: "ci", scopes: ["vocab:read", "library:write"], expiresInDays: 30 });

    const listed = await run(["keys", "list"], () => res(200, { keys: [{ id: "k1", name: "ci", prefix: "ok_live_secr", scopes: ["vocab:read"], createdAt: "", lastUsedAt: null, expiresAt: null }], availableScopes: [] }));
    expect(listed.stdout).toContain("k1  ok_live_secr…  ci");

    const revoked = await run(["keys", "revoke", "k1", "--json"], (c) => (c.method === "DELETE" && c.url.pathname === "/api/v1/keys/k1" ? res(200, { ok: true }) : undefined));
    expect(revoked.json()).toEqual({ ok: true, id: "k1" });
  });
});
