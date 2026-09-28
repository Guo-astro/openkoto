import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runCli, type CliDeps } from "../src/cli";
import { csvToVocab } from "../src/csv";

const BASE = "https://koto.test";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: any;
}

type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>;

function res(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const ME_PLUS = { user: { id: "u1", email: "a@b.c", name: "A", image: null, createdAt: "" }, plan: "plus", entitlements: { sync: true, cli: true, apiKeys: true, hostedAi: false }, subscriptions: [], credits: 0, pendingDeletion: null };
const ME_FREE = { ...ME_PLUS, plan: "free", entitlements: { sync: true, cli: false, apiKeys: false, hostedAi: false } };

function vocab(id: string, word: string, extra: Record<string, unknown> = {}) {
  return { id, word, meaning: `${word}-m`, srsState: "new", stability: 0, difficulty: 0, dueDate: "2026-09-28", reviewCount: 0, createdAt: "", updatedAt: "", ...extra };
}

let dir: string;
let calls: Call[];

async function run(argv: string[], handler: Handler, extra: Partial<CliDeps> & { env?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const fetch = async (input: string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: new URL(input),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = await handler(call);
    if (!r) throw new Error(`unexpected request ${call.method} ${input}`);
    return r;
  };
  const code = await runCli(argv, {
    env: { KOTO_CONFIG_DIR: dir, KOTO_API_BASE: BASE, ...(extra.env ?? {}) },
    fetch,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    openBrowser: async () => false,
    readKey: null,
    sleep: async () => {},
    ...extra,
  });
  return { code, stdout: out.join(""), stderr: err.join(""), json: () => JSON.parse(out.join("")) };
}

async function login(expiresAt = Date.now() + 3_600_000) {
  await writeFile(join(dir, "credentials.json"), JSON.stringify({ accessToken: "at1", refreshToken: "rt1", expiresAt, baseUrl: BASE }));
}

/** Routes /api/v1/me to `me`, everything else to `handler`. */
function withMe(me: unknown, handler: Handler = () => undefined): Handler {
  return (call) => (call.url.pathname === "/api/v1/me" ? res(200, me) : handler(call));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "koto-test-"));
  calls = [];
});

describe("argument parsing and exit codes", () => {
  it("prints help with exit 0", async () => {
    const r = await run(["--help"], () => undefined);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("lyrics");
  });

  it("returns 2 for unknown commands, missing options and bad values", async () => {
    await login();
    expect((await run(["frobnicate"], () => undefined)).code).toBe(2);
    expect((await run(["lyrics", "translate", "x.lrc"], () => undefined)).code).toBe(2);
    expect((await run(["vocab", "grade", "id1", "9"], () => undefined)).code).toBe(2);
    expect((await run(["vocab", "due", "--limit", "0"], () => undefined)).code).toBe(2);
    expect((await run(["config", "set", "nope", "1"], () => undefined)).code).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("returns 3 when not logged in", async () => {
    const r = await run(["vocab", "due", "--json"], () => undefined);
    expect(r.code).toBe(3);
    expect(r.json()).toEqual({ error: { code: "NOT_LOGGED_IN", message: expect.any(String), exitCode: 3 } });
  });

  it("maps a 401 from the server to exit 3", async () => {
    await writeFile(join(dir, "credentials.json"), JSON.stringify({ accessToken: "bad" }));
    const r = await run(["whoami"], () => res(401, { error: { code: "UNAUTHENTICATED", message: "invalid access token" } }));
    expect(r.code).toBe(3);
  });
});

describe("plan gate", () => {
  it("blocks library commands for free accounts with exit 4 but allows whoami", async () => {
    await login();
    const blocked = await run(["vocab", "due", "--json"], withMe(ME_FREE));
    expect(blocked.code).toBe(4);
    expect(blocked.json().error.code).toBe("PLAN_REQUIRED");

    const who = await run(["whoami", "--json"], withMe(ME_FREE));
    expect(who.code).toBe(0);
    expect(who.json()).toMatchObject({ email: "a@b.c", plan: "free", entitlements: { cli: false }, auth: "credentials" });
  });

  it("caches a positive entitlement check", async () => {
    await login();
    const handler = withMe(ME_PLUS, () => res(200, { items: [], total: 0 }));
    await run(["vocab", "list"], handler);
    await run(["vocab", "list"], handler);
    expect(calls.filter((c) => c.url.pathname === "/api/v1/me")).toHaveLength(1);
  });

  it("uses KOTO_API_KEY as a bearer token", async () => {
    const r = await run(["vocab", "due", "--json"], withMe(ME_PLUS, () => res(200, { items: [], total: 0, date: "2026-09-28" })), { env: { KOTO_API_KEY: "ok_live_abc" } });
    expect(r.code).toBe(0);
    expect(calls.every((c) => c.headers.Authorization === "Bearer ok_live_abc")).toBe(true);
  });

  it("maps 402 QUOTA_EXCEEDED to exit 4", async () => {
    await login();
    const r = await run(["vocab", "add", "word"], withMe(ME_PLUS, () => res(402, { error: { code: "QUOTA_EXCEEDED", message: "vocabulary limit reached" } })));
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("vocabulary limit reached");
  });
});

describe("json output", () => {
  it("vocab due returns the server page verbatim", async () => {
    await login();
    const page = { items: [vocab("v1", "猫")], total: 1, date: "2026-09-28" };
    const r = await run(["--json", "vocab", "due", "--limit", "5", "--pack", "N3"], withMe(ME_PLUS, (c) => (c.url.pathname === "/api/v1/library/vocab" ? res(200, page) : undefined)));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual(page);
    const call = calls.find((c) => c.url.pathname === "/api/v1/library/vocab")!;
    expect(call.url.searchParams.get("due")).toBe("1");
    expect(call.url.searchParams.get("limit")).toBe("5");
    expect(call.url.searchParams.get("pack")).toBe("N3");
  });

  it("vocab add sends the word and pack", async () => {
    await login();
    const r = await run(["vocab", "add", "懐かしい", "-m", "nostalgic", "--pack", "N3", "--json"], withMe(ME_PLUS, (c) => res(201, { vocab: vocab("v2", c.body.word), created: true, deduped: false })));
    expect(r.json()).toMatchObject({ created: true, vocab: { word: "懐かしい" } });
    expect(calls.at(-1)!.body).toMatchObject({ word: "懐かしい", meaning: "nostalgic", pack: "N3" });
  });

  it("config set/get masks the api key", async () => {
    expect((await run(["config", "set", "byok.api_key", "sk-1234567890abcdef"], () => undefined)).code).toBe(0);
    const r = await run(["config", "get", "byok.api_key", "--json"], () => undefined);
    expect(r.json()).toEqual({ key: "byok.api_key", value: "sk-1…cdef" });
    const mode = (await stat(join(dir, "config.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("login", () => {
  it("runs the device flow and stores credentials with 0600", async () => {
    let polls = 0;
    const r = await run(["login", "--json"], (c) => {
      if (c.url.pathname === "/api/v1/auth/device/code") {
        return res(200, { deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: `${BASE}/device`, verificationUriComplete: `${BASE}/device?code=ABCD-EFGH`, interval: 1, expiresIn: 600 });
      }
      if (c.url.pathname === "/api/v1/auth/token") {
        polls++;
        if (polls === 1) return res(400, { error: { code: "authorization_pending", message: "pending" } });
        return res(200, { accessToken: "at9", refreshToken: "rt9", tokenType: "Bearer", expiresIn: 900, deviceId: "d1", user: { id: "u1", email: "a@b.c" } });
      }
      if (c.url.pathname === "/api/v1/me") return res(200, ME_FREE);
      return undefined;
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("ABCD-EFGH");
    expect(r.json()).toMatchObject({ ok: true, user: { email: "a@b.c" }, plan: "free", entitlements: { cli: false } });
    const creds = JSON.parse(await readFile(join(dir, "credentials.json"), "utf8"));
    expect(creds).toMatchObject({ accessToken: "at9", refreshToken: "rt9", baseUrl: BASE });
    expect((await stat(join(dir, "credentials.json"))).mode & 0o777).toBe(0o600);
    expect(calls[0]!.body).toMatchObject({ clientId: "cli", device: { platform: "cli" } });
  });

  it("logout clears credentials", async () => {
    await login();
    const r = await run(["logout"], (c) => (c.url.pathname === "/api/v1/auth/logout" ? res(200, { ok: true }) : undefined));
    expect(r.code).toBe(0);
    await expect(stat(join(dir, "credentials.json"))).rejects.toThrow();
  });
});

describe("lyrics translate", () => {
  const LRC = "[ti:Song]\n[ar:Artist]\n[00:01.00]一行目\n[00:03.00]二行目\n";

  async function byokConfig() {
    await writeFile(join(dir, "config.json"), JSON.stringify({ byok: { base_url: "https://llm.test/v1", api_key: "sk-test", model: "m1" } }));
  }

  function llm(replies: string[]): Handler {
    let n = 0;
    return (c) => {
      if (c.url.host !== "llm.test") return undefined;
      expect(c.headers.Authorization).toBe("Bearer sk-test");
      return res(200, { choices: [{ message: { content: replies[n++] } }] });
    };
  }

  it("translates locally with BYOK, retrying once on misalignment, without touching the API", async () => {
    await byokConfig();
    const file = join(dir, "song.lrc");
    await writeFile(file, LRC);
    const handler = llm(['[{"i":1,"translation":"line one"}]', '[{"i":1,"translation":"line one"},{"i":2,"translation":"line two"}]']);
    const r = await run(["lyrics", "translate", file, "--to", "en", "--byok"], handler);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("[ti:Song]\n[ar:Artist]\n[00:01.00]一行目\n[00:01.00]line one\n[00:03.00]二行目\n[00:03.00]line two\n");
    const llmCalls = calls.filter((c) => c.url.host === "llm.test");
    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[0]!.body).toMatchObject({ model: "m1" });
    expect(llmCalls[1]!.body.messages).toHaveLength(4);
    expect(llmCalls[1]!.body.messages[3].content).toContain("exactly 2 items");
    expect(calls.some((c) => c.url.host === "koto.test")).toBe(false);
  });

  it("--json --save --out writes the file and saves to the library", async () => {
    await byokConfig();
    await login();
    const file = join(dir, "song.lrc");
    const out = join(dir, "song.en.lrc");
    await writeFile(file, LRC);
    const api: Handler = (c) => (c.url.pathname === "/api/v1/library/lyrics" && c.method === "POST" ? res(201, { article: { id: "l1", title: c.body.title }, meta: {}, segments: [] }) : undefined);
    const handler = llm(['[{"i":1,"translation":"one"},{"i":2,"translation":"two"}]']);
    const r = await run(["lyrics", "translate", file, "--to", "en", "--byok", "--save", "--out", out, "--json"], (c) => handler(c) ?? withMe(ME_PLUS, api)(c));
    expect(r.code).toBe(0);
    const body = r.json();
    expect(body).toMatchObject({ title: "Song", artist: "Artist", targetLanguage: "en", format: "lrc", engine: "byok", aligned: true, saved: { id: "l1" }, out });
    expect(body.lines).toEqual([
      { startTime: 1, endTime: 3, text: "一行目", translation: "one" },
      { startTime: 3, endTime: expect.any(Number), text: "二行目", translation: "two" },
    ]);
    const saved = calls.find((c) => c.url.pathname === "/api/v1/library/lyrics")!;
    expect(saved.body).toMatchObject({ title: "Song", artist: "Artist", format: "lrc", translations: ["one", "two"], raw: LRC });
    expect(await readFile(out, "utf8")).toContain("[00:03.00]two");
  });

  it("explains BYOK setup when hosted AI is unavailable", async () => {
    await login();
    const file = join(dir, "song.txt");
    await writeFile(file, "hello\nworld\n");
    const r = await run(["lyrics", "translate", file, "--to", "zh"], withMe(ME_PLUS));
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("--byok");
  });

  it("reports a missing hosted endpoint for entitled users", async () => {
    await login();
    const file = join(dir, "song.txt");
    await writeFile(file, "hello\n");
    const me = { ...ME_PLUS, entitlements: { ...ME_PLUS.entitlements, hostedAi: true } };
    const r = await run(["lyrics", "translate", file, "--to", "zh", "--json"], withMe(me, () => res(404, { error: { code: "NOT_FOUND", message: "not found" } })));
    expect(r.code).toBe(1);
    expect(r.json().error.code).toBe("HOSTED_AI_NOT_AVAILABLE_YET");
  });

  it("uses hosted AI when entitled", async () => {
    await login();
    const file = join(dir, "song.txt");
    await writeFile(file, "hello\nworld\n");
    const me = { ...ME_PLUS, entitlements: { ...ME_PLUS.entitlements, hostedAi: true } };
    const r = await run(["lyrics", "translate", file, "--to", "zh", "--json"], withMe(me, (c) =>
      c.url.pathname === "/api/v1/ai/translate-lyrics" ? res(200, { translations: ["你好", "世界"], aligned: true, credits: 3, cached: false }) : undefined,
    ));
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ engine: "hosted", aligned: true, credits: 3, lines: [{ text: "hello", translation: "你好" }, { text: "world", translation: "世界" }] });
    expect(calls.find((c) => c.url.pathname === "/api/v1/ai/translate-lyrics")!.body).toEqual({ lines: ["hello", "world"], targetLanguage: "zh", title: "song" });
  });

  it("maps INSUFFICIENT_CREDITS to exit 4", async () => {
    await login();
    const file = join(dir, "song.txt");
    await writeFile(file, "hello\n");
    const me = { ...ME_PLUS, entitlements: { ...ME_PLUS.entitlements, hostedAi: true } };
    const r = await run(["lyrics", "translate", file, "--to", "zh"], withMe(me, () => res(402, { error: { code: "INSUFFICIENT_CREDITS", message: "not enough credits" } })));
    expect(r.code).toBe(4);
  });

  it("errors clearly when BYOK is not configured", async () => {
    const file = join(dir, "song.txt");
    await writeFile(file, "hello\n");
    const r = await run(["lyrics", "translate", file, "--to", "zh", "--byok"], () => undefined);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("koto config set byok.base_url");
  });

  it("exports saved lyrics as markdown", async () => {
    await login();
    const detail = {
      article: { id: "l1", title: "Song", content: "", createdAt: "" },
      meta: { articleId: "l1", artist: "Artist" },
      segments: [
        { id: "s1", articleId: "l1", order: 0, text: "一行目", translation: "one", isNewParagraph: true, createdAt: "", startTime: 1, endTime: 2 },
        { id: "s2", articleId: "l1", order: 1, text: "二行目", isNewParagraph: true, createdAt: "", startTime: 2, endTime: 3 },
      ],
    };
    const r = await run(["lyrics", "export", "l1", "--format", "md"], withMe(ME_PLUS, () => res(200, detail)));
    expect(r.stdout).toBe("# Song\n\n*Artist*\n\n一行目  \none\n\n二行目\n");
    const lrc = await run(["lyrics", "export", "l1"], withMe(ME_PLUS, () => res(200, detail)));
    expect(lrc.stdout).toBe("[ti:Song]\n[ar:Artist]\n[00:01.00]一行目\n[00:01.00]one\n[00:02.00]二行目\n");
  });
});

describe("vocab review and import", () => {
  it("runs an interactive review session from key presses", async () => {
    await login();
    const queue = { items: [vocab("v1", "猫"), vocab("v2", "犬"), vocab("v3", "鳥")], total: 3 };
    const keys = [" ", "3", "s", "1", "q"];
    const r = await run(
      ["vocab", "review", "--json"],
      withMe(ME_PLUS, (c) => {
        if (c.method === "GET") return res(200, queue);
        const id = c.url.pathname.split("/")[5]!;
        return res(200, { vocab: { ...vocab(id, "x"), dueDate: "2026-10-01" }, event: { grade: c.body.grade } });
      }),
      { readKey: async () => keys.shift() ?? "q" },
    );
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      reviewed: 2,
      results: [
        { id: "v1", word: "猫", grade: 3, dueDate: "2026-10-01" },
        { id: "v3", word: "鳥", grade: 1, dueDate: "2026-10-01" },
      ],
    });
    expect(r.stderr).toContain("猫-m");
  });

  it("refuses interactive review without a TTY", async () => {
    await login();
    expect((await run(["vocab", "review"], withMe(ME_PLUS))).code).toBe(2);
  });

  it("imports CSV rows with dedupe accounting", async () => {
    await login();
    const file = join(dir, "words.csv");
    await writeFile(file, 'word,meaning,reading\n猫,cat,ねこ\n"犬, dog",dog,いぬ\n猫,cat,\n');
    let n = 0;
    const r = await run(["vocab", "import", file, "--pack", "N5", "--json"], withMe(ME_PLUS, (c) => res(n++ === 2 ? 200 : 201, { vocab: vocab("x", c.body.word), created: n <= 2, deduped: n > 2 })));
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({ imported: 2, deduped: 1, failed: [], stoppedEarly: false });
    const adds = calls.filter((c) => c.url.pathname === "/api/v1/library/vocab");
    expect(adds.map((c) => c.body.word)).toEqual(["猫", "犬, dog", "猫"]);
    expect(adds[0]!.body).toMatchObject({ meaning: "cat", reading: "ねこ", pack: ["N5"] });
  });

  it("parses header-less and tab separated CSV", () => {
    expect(csvToVocab("a,b\nc,d")).toEqual([
      { word: "a", meaning: "b" },
      { word: "c", meaning: "d" },
    ]);
    expect(csvToVocab("単語\t意味\n猫\tcat\n")).toEqual([{ word: "猫", meaning: "cat" }]);
  });
});
