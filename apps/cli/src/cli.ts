// koto — OpenKoto CLI. `runCli(argv, deps)` is the testable entry; src/bin.ts wires real IO.

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, extname } from "node:path";
import { Command, CommanderError, Option } from "commander";
import { ApiError, OpenKotoClient, type AccountSummary, type FetchLike } from "@openkoto/client";
import { parseLyrics, type LyricsSourceFormat } from "@openkoto/core";
import { requireByok, translateLyricsByok } from "./byok";
import { CONFIG_KEYS, ConfigStore, configDir, isConfigKey, resolveAuth, type Env, type ResolvedAuth } from "./config";
import { csvToVocab } from "./csv";
import { CliError, EXIT, notLoggedIn, planRequired, toCliError, usageError } from "./errors";
import { importBook } from "./book-import";
import { parseChapterRanges } from "./books";
import { LibraryClient, type Job, type Vocab } from "./library";
import { mergeTranslations, toBilingualLrc, toMarkdown, type TranslatedLine } from "./lyrics";

export const VERSION = "0.2.0";
const ENTITLEMENT_CACHE_MS = 60 * 60 * 1000;

export interface CliDeps {
  env: Env;
  fetch: FetchLike;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Opens a URL in the browser; resolves false when that is not possible. */
  openBrowser: (url: string) => Promise<boolean>;
  /** Interactive key source for `vocab review`; null when stdin is not a TTY. */
  readKey: (() => Promise<string>) | null;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

interface Ctx {
  store: ConfigStore;
  auth: ResolvedAuth;
  client: OpenKotoClient;
  library: LibraryClient;
}

function defaultOpenBrowser(url: string): Promise<boolean> {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

function defaultDeps(): CliDeps {
  return {
    env: process.env,
    fetch: (input, init) => globalThis.fetch(input, init),
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    openBrowser: defaultOpenBrowser,
    readKey: null,
  };
}

const GRADE_LABELS: Record<number, string> = { 1: "again", 2: "hard", 3: "good", 4: "easy" };

function parseGrade(value: string): number {
  const named: Record<string, number> = { again: 1, hard: 2, good: 3, easy: 4 };
  const n = named[value.toLowerCase()] ?? Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw usageError("grade must be 1-4 (again/hard/good/easy)");
  return n;
}

function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw usageError("--limit must be a positive integer");
  return n;
}

function mask(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.length <= 8 ? "****" : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function lyricsFormatFor(file: string, explicit?: string): LyricsSourceFormat | undefined {
  if (explicit) {
    if (!["lrc", "txt", "srt"].includes(explicit)) throw usageError("--format must be lrc, txt or srt");
    return explicit as LyricsSourceFormat;
  }
  const ext = extname(file).slice(1).toLowerCase();
  return ext === "lrc" || ext === "srt" || ext === "txt" ? ext : undefined;
}

function htmlToText(html: string): { title: string | null; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = body
    .replace(/<(script|style|noscript|nav|header|footer|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|section|article|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { title: title ? htmlToText(title).text || title : null, text };
}

function vocabLine(v: Vocab): string {
  const reading = v.reading ? ` [${v.reading}]` : "";
  const meaning = v.meaning ? ` — ${v.meaning}` : "";
  return `${v.word}${reading}${meaning}  (${v.srsState}, due ${v.dueDate}, id ${v.id})`;
}

export async function runCli(argv: string[], partial: Partial<CliDeps> = {}): Promise<number> {
  const deps: CliDeps = { ...defaultDeps(), ...partial };
  let json = argv.includes("--json");
  const store = new ConfigStore(configDir(deps.env));

  const print = (text: string) => deps.stdout(text.endsWith("\n") ? text : `${text}\n`);
  const info = (text: string) => deps.stderr(text.endsWith("\n") ? text : `${text}\n`);
  /** Stable JSON for --json, otherwise the human rendering. */
  const emit = (data: unknown, human: () => string | string[]) => {
    if (json) return print(JSON.stringify(data, null, 2));
    const h = human();
    print(Array.isArray(h) ? h.join("\n") : h);
  };

  let ctxPromise: Promise<Ctx> | null = null;
  const context = (): Promise<Ctx> => {
    ctxPromise ??= (async () => {
      const auth = await resolveAuth(store, deps.env);
      const client = new OpenKotoClient({
        baseUrl: auth.baseUrl,
        clientName: `cli/${VERSION}`,
        tokenStore: auth.tokenStore,
        fetch: deps.fetch,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.now ? { now: deps.now } : {}),
      });
      return { store, auth, client, library: new LibraryClient(client) };
    })();
    return ctxPromise;
  };

  const loggedIn = async (): Promise<Ctx> => {
    const ctx = await context();
    if (ctx.auth.source === "none") throw notLoggedIn();
    return ctx;
  };

  /** Login + Plus gate for everything except login/logout/whoami/config. */
  const gated = async (): Promise<Ctx> => {
    const ctx = await loggedIn();
    const now = (deps.now ?? Date.now)();
    if (ctx.auth.source === "credentials") {
      const creds = await store.readCredentials();
      if (creds?.cliEntitledAt && now - creds.cliEntitledAt < ENTITLEMENT_CACHE_MS) return ctx;
    }
    const me = await ctx.client.me();
    if (!me.entitlements.cli) throw planRequired();
    if (ctx.auth.source === "credentials") {
      const creds = await store.readCredentials();
      if (creds) await store.writeCredentials({ ...creds, cliEntitledAt: now });
    }
    return ctx;
  };

  const program = new Command("koto")
    .description("OpenKoto from the terminal: vocabulary review, lyrics translation and your reading library.")
    .version(VERSION, "-v, --version")
    .option("--json", "print stable machine-readable JSON")
    .exitOverride()
    .configureOutput({ writeOut: (s) => deps.stdout(s), writeErr: (s) => deps.stderr(s), outputError: (s, write) => write(s) })
    .showHelpAfterError("(run with --help for usage)")
    .hook("preAction", () => {
      json = json || !!program.opts().json;
    });

  // ---- auth ---------------------------------------------------------------

  program
    .command("login")
    .description("sign in with your OpenKoto account (device code flow)")
    .option("--no-browser", "do not try to open the browser")
    .action(async (opts: { browser: boolean }) => {
      const auth = await resolveAuth(store, { ...deps.env, KOTO_API_KEY: undefined });
      const client = new OpenKotoClient({
        baseUrl: auth.baseUrl,
        clientName: `cli/${VERSION}`,
        tokenStore: auth.tokenStore,
        fetch: deps.fetch,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
      });
      if (deps.env.KOTO_API_KEY) info("Note: KOTO_API_KEY is set and takes precedence over this login.");
      const code = await client.startDeviceLogin({ platform: "cli", name: `koto CLI (${hostname()})`, appVersion: VERSION });
      info(`To sign in, open ${code.verificationUriComplete}\nand confirm the code: ${code.userCode}`);
      if (opts.browser && (await deps.openBrowser(code.verificationUriComplete))) info("(opened your browser)");
      info("Waiting for approval…");
      let tokens;
      try {
        tokens = await client.pollDeviceLogin(code.deviceCode, code.interval);
      } catch (err) {
        if (err instanceof ApiError && (err.code === "expired_token" || err.code === "access_denied")) {
          throw new CliError(EXIT.NOT_LOGGED_IN, err.code, err.code === "expired_token" ? "The code expired. Run `koto login` again." : "Sign-in was denied.");
        }
        throw err;
      }
      let me: AccountSummary | null = null;
      try {
        me = await client.me();
      } catch {
        // Login succeeded; the summary is only for the hint below.
      }
      if (me?.entitlements.cli) {
        const creds = await store.readCredentials();
        if (creds) await store.writeCredentials({ ...creds, cliEntitledAt: (deps.now ?? Date.now)() });
      }
      emit({ ok: true, user: tokens.user ?? null, plan: me?.plan ?? tokens.user?.plan ?? null, entitlements: me?.entitlements ?? null, apiBase: auth.baseUrl }, () => {
        const lines = [`Logged in as ${tokens.user?.email ?? "unknown"}${me ? ` (${me.plan})` : ""}.`];
        if (me && !me.entitlements.cli) lines.push(planRequired().message);
        return lines;
      });
    });

  program
    .command("logout")
    .description("sign out and revoke this device")
    .action(async () => {
      const auth = await resolveAuth(store, { ...deps.env, KOTO_API_KEY: undefined });
      const client = new OpenKotoClient({ baseUrl: auth.baseUrl, clientName: `cli/${VERSION}`, tokenStore: auth.tokenStore, fetch: deps.fetch });
      const had = auth.source === "credentials";
      try {
        await client.logout();
      } catch {
        // Local credentials are cleared regardless (client.logout's finally).
      }
      await store.writeCredentials(null);
      emit({ ok: true, wasLoggedIn: had }, () => (had ? "Logged out." : "Not logged in."));
    });

  program
    .command("whoami")
    .description("show the signed-in account, plan and entitlements")
    .action(async () => {
      const ctx = await loggedIn();
      const me = await ctx.client.me();
      emit(
        { userId: me.user.id, email: me.user.email, plan: me.plan, entitlements: me.entitlements, credits: me.credits, apiBase: ctx.auth.baseUrl, auth: ctx.auth.source },
        () => {
          const lines = [
            `${me.user.email} — ${me.plan} plan${me.credits ? `, ${me.credits} credits` : ""}`,
            `API: ${ctx.auth.baseUrl} (${ctx.auth.source === "api_key" ? "KOTO_API_KEY" : "device login"})`,
          ];
          if (!me.entitlements.cli) lines.push(planRequired().message);
          return lines;
        },
      );
    });

  // ---- config -------------------------------------------------------------

  const config = program.command("config").description(`read or change settings (${CONFIG_KEYS.join(", ")})`);
  config
    .command("get [key]")
    .description("print one setting, or all of them")
    .action(async (key?: string) => {
      if (key && !isConfigKey(key)) throw usageError(`unknown key "${key}"; valid keys: ${CONFIG_KEYS.join(", ")}`);
      const keys = key ? [key as (typeof CONFIG_KEYS)[number]] : [...CONFIG_KEYS];
      const values: Record<string, string | null> = {};
      for (const k of keys) {
        const v = await store.get(k);
        values[k] = (k === "byok.api_key" ? mask(v) : v) ?? null;
      }
      emit(key ? { key, value: values[key] } : { values, path: store.configPath }, () =>
        key ? (values[key] ?? "") : keys.map((k) => `${k} = ${values[k] ?? ""}`),
      );
    });
  config
    .command("set <key> [value]")
    .description("set a setting (omit value to unset)")
    .action(async (key: string, value?: string) => {
      if (!isConfigKey(key)) throw usageError(`unknown key "${key}"; valid keys: ${CONFIG_KEYS.join(", ")}`);
      if ((key === "api_base" || key === "byok.base_url") && value && !/^https?:\/\//.test(value)) throw usageError(`${key} must be an http(s) URL`);
      await store.set(key, value);
      const shown = key === "byok.api_key" ? mask(value) : value;
      emit({ key, value: shown ?? null }, () => (value === undefined ? `unset ${key}` : `${key} = ${shown}`));
    });

  // ---- vocabulary ---------------------------------------------------------

  const vocab = program.command("vocab").description("your vocabulary cards (FSRS review)");

  vocab
    .command("due")
    .description("cards due for review today")
    .option("--limit <n>", "maximum cards", parseLimit, 50)
    .option("--pack <pack>", "only this word pack (id or name)")
    .action(async (opts: { limit: number; pack?: string }) => {
      const { library } = await gated();
      const res = await library.listVocab({ due: true, limit: opts.limit, pack: opts.pack });
      emit(res, () => (res.items.length ? [`${res.total} due${res.date ? ` on ${res.date}` : ""}:`, ...res.items.map(vocabLine)] : "Nothing due."));
    });

  vocab
    .command("list")
    .description("list cards")
    .option("--limit <n>", "maximum cards", parseLimit, 100)
    .option("--pack <pack>", "only this word pack (id or name)")
    .option("-q, --query <text>", "filter by word or meaning")
    .action(async (opts: { limit: number; pack?: string; query?: string }) => {
      const { library } = await gated();
      const res = await library.listVocab({ limit: opts.limit, pack: opts.pack, q: opts.query });
      emit(res, () => [`${res.total} cards`, ...res.items.map(vocabLine)]);
    });

  vocab
    .command("add <word>")
    .description("add a word (duplicates are merged)")
    .option("-m, --meaning <text>")
    .option("-r, --reading <text>")
    .option("-e, --example <text>")
    .option("--pack <pack>", "word pack id or name (created if missing)")
    .option("--from <articleId>", "source article id")
    .action(async (word: string, opts: { meaning?: string; reading?: string; example?: string; pack?: string; from?: string }) => {
      const { library } = await gated();
      const res = await library.addVocab({ word, meaning: opts.meaning, reading: opts.reading, example: opts.example, pack: opts.pack, sourceArticleId: opts.from });
      emit(res, () => `${res.created ? "Added" : "Already saved (merged)"}: ${vocabLine(res.vocab)}`);
    });

  vocab
    .command("grade <id> <grade>")
    .description("record one review: 1=again 2=hard 3=good 4=easy (non-interactive)")
    .action(async (id: string, gradeArg: string) => {
      const grade = parseGrade(gradeArg);
      const { library } = await gated();
      const res = await library.reviewVocab(id, grade);
      emit(res, () => `${res.vocab.word}: ${GRADE_LABELS[grade]} → next due ${res.vocab.dueDate}`);
    });

  vocab
    .command("rm <id>")
    .description("delete a card")
    .action(async (id: string) => {
      const { library } = await gated();
      const res = await library.deleteVocab(id);
      emit(res, () => `Deleted ${res.id}`);
    });

  vocab
    .command("review")
    .description("interactive review in the terminal (space = flip, 1-4 = grade, s = skip, q = quit)")
    .option("--limit <n>", "maximum cards", parseLimit, 50)
    .option("--pack <pack>", "only this word pack (id or name)")
    .action(async (opts: { limit: number; pack?: string }) => {
      if (!deps.readKey) throw usageError("`koto vocab review` needs an interactive terminal; use `koto vocab due --json` + `koto vocab grade <id> <1-4>` in scripts");
      const { library } = await gated();
      const queue = await library.listVocab({ due: true, limit: opts.limit, pack: opts.pack });
      const results: { id: string; word: string; grade: number; dueDate: string }[] = [];
      if (!queue.items.length) {
        emit({ reviewed: 0, results }, () => "Nothing due.");
        return;
      }
      const readKey = deps.readKey;
      info(`${queue.items.length} cards. space = flip · 1 again · 2 hard · 3 good · 4 easy · s skip · q quit\n`);
      outer: for (const [i, card] of queue.items.entries()) {
        info(`[${i + 1}/${queue.items.length}]  ${card.word}`);
        let flipped = false;
        for (;;) {
          const key = await readKey();
          if (key === "q" || key === "\u0003" || key === "escape") break outer;
          if (key === "s") break;
          if (key === " " || key === "space" || key === "return" || key === "\r") {
            if (!flipped) {
              flipped = true;
              const back = [card.reading && `  ${card.reading}`, `  ${card.meaning || "(no meaning)"}`, card.example && `  e.g. ${card.example}`].filter(Boolean);
              info(back.join("\n"));
            }
            continue;
          }
          if (/^[1-4]$/.test(key)) {
            const grade = Number(key);
            const res = await library.reviewVocab(card.id, grade);
            results.push({ id: card.id, word: card.word, grade, dueDate: res.vocab.dueDate });
            info(`  → ${GRADE_LABELS[grade]}, next ${res.vocab.dueDate}\n`);
            break;
          }
        }
      }
      emit({ reviewed: results.length, results }, () => `Reviewed ${results.length} card${results.length === 1 ? "" : "s"}.`);
    });

  vocab
    .command("import <csv>")
    .description("import words from CSV (header: word,meaning,reading,example[,pack])")
    .option("--pack <pack>", "word pack for every row (id or name)")
    .action(async (file: string, opts: { pack?: string }) => {
      const rows = csvToVocab(await readFile(file, "utf8"));
      if (!rows.length) throw usageError(`no words found in ${file}`);
      const { library } = await gated();
      let imported = 0;
      let deduped = 0;
      const failed: { row: number; word: string; error: string }[] = [];
      for (const [i, row] of rows.entries()) {
        try {
          const res = await library.addVocab({ ...row, pack: [opts.pack, row.pack].filter((p): p is string => !!p) });
          if (res.created) imported++;
          else deduped++;
        } catch (err) {
          const e = toCliError(err);
          // Quota / auth problems will fail every remaining row too.
          if (e.exitCode === EXIT.PLAN || e.exitCode === EXIT.NOT_LOGGED_IN) {
            failed.push({ row: i + 1, word: row.word, error: e.message });
            emit({ imported, deduped, failed, stoppedEarly: true }, () => `Imported ${imported}, merged ${deduped}; stopped at row ${i + 1}: ${e.message}`);
            throw new CliError(e.exitCode, e.code, e.message);
          }
          failed.push({ row: i + 1, word: row.word, error: e.message });
        }
      }
      emit({ imported, deduped, failed, stoppedEarly: false }, () => [
        `Imported ${imported} new word${imported === 1 ? "" : "s"}, merged ${deduped} duplicate${deduped === 1 ? "" : "s"}.`,
        ...failed.map((f) => `  row ${f.row} (${f.word}): ${f.error}`),
      ]);
      if (failed.length) throw new CliError(EXIT.ERROR, "PARTIAL_IMPORT", `${failed.length} rows failed`);
    });

  // ---- lyrics -------------------------------------------------------------

  const lyrics = program.command("lyrics").description("song lyrics: translate, save, export");

  lyrics
    .command("translate <file>")
    .description("translate a .lrc/.srt/.txt file line by line")
    .requiredOption("--to <lang>", "target language code, e.g. zh, en, ja")
    .option("--save", "save the lyrics + translation to your OpenKoto library")
    .option("--out <file>", "write the bilingual result to a file")
    .option("--byok", "translate locally with your own OpenAI-compatible provider (koto config set byok.*)")
    .option("--title <title>")
    .option("--artist <artist>")
    .addOption(new Option("--format <format>", "input format (default: from extension / content)").choices(["lrc", "txt", "srt"]))
    .action(async (file: string, opts: { to: string; save?: boolean; out?: string; byok?: boolean; title?: string; artist?: string; format?: string }) => {
      const raw = await readFile(file, "utf8");
      const format = lyricsFormatFor(file, opts.format);
      const parsed = parseLyrics(raw, format);
      if (!parsed.lines.length) throw usageError(`no lyric lines found in ${file}`);
      const title = opts.title ?? parsed.meta.title ?? basename(file, extname(file));
      const artist = opts.artist ?? parsed.meta.artist;
      const lines = parsed.lines.map((l) => l.text);

      let translations: string[];
      let aligned = true;
      let engine: "byok" | "hosted";
      let creditsUsed: number | null = null;
      // Saving (and hosted AI) needs the Plus CLI entitlement; pure local BYOK does not touch the API.
      const ctx = opts.save || !opts.byok ? await gated() : null;
      if (opts.byok) {
        const cfg = requireByok((await store.load()).byok);
        info(`Translating ${lines.length} lines with ${cfg.model}…`);
        const res = await translateLyricsByok({ lines, targetLanguage: opts.to, title, artist }, cfg, deps.fetch);
        translations = res.translations;
        aligned = res.aligned;
        engine = "byok";
        if (!aligned) info("Warning: the model's answer was not line-aligned after a retry; some lines may be empty.");
      } else {
        const me = await ctx!.client.me();
        if (!me.entitlements.hostedAi) {
          throw new CliError(
            EXIT.PLAN,
            "HOSTED_AI_UNAVAILABLE",
            "Hosted AI translation needs Pro or AI credits. Use your own provider instead:\n" +
              "  koto config set byok.base_url https://api.openai.com/v1\n  koto config set byok.api_key sk-...\n  koto config set byok.model gpt-4o-mini\n" +
              `  koto lyrics translate ${file} --to ${opts.to} --byok`,
          );
        }
        try {
          const hosted = await ctx!.library.translateLyricsHosted({ lines, targetLanguage: opts.to, title, artist });
          translations = hosted.translations;
          aligned = hosted.aligned ?? true;
          creditsUsed = hosted.credits ?? null;
          engine = "hosted";
          if (hosted.credits) info(`Used ${hosted.credits} credits.`);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            throw new CliError(EXIT.ERROR, "HOSTED_AI_NOT_AVAILABLE_YET", "Hosted AI translation is not available on this server yet (coming soon). Use --byok with your own provider for now.");
          }
          throw err;
        }
      }

      const merged: TranslatedLine[] = mergeTranslations(parsed.lines, translations);
      const rendered = parsed.lines.some((l) => l.startTime !== null)
        ? toBilingualLrc(merged, { title, artist })
        : merged.map((l) => (l.translation ? `${l.text}\n${l.translation}` : l.text)).join("\n") + "\n";

      let saved: { id: string } | null = null;
      if (opts.save) {
        const res = await ctx!.library.createLyrics({ title, artist, raw, format: parsed.format, language: undefined, translations });
        saved = { id: res.article.id };
        info(`Saved to your library: ${res.article.id}`);
      }
      if (opts.out) await writeFile(opts.out, rendered);
      if (json) {
        emit({ title, artist: artist ?? null, targetLanguage: opts.to, format: parsed.format, engine, aligned, credits: creditsUsed, lines: merged, saved, out: opts.out ?? null }, () => "");
      } else if (opts.out) {
        info(`Wrote ${opts.out}`);
      } else {
        deps.stdout(rendered);
      }
    });

  lyrics
    .command("add <file>")
    .description("save a .lrc/.srt/.txt file to your library (no translation)")
    .option("--title <title>")
    .option("--artist <artist>")
    .addOption(new Option("--format <format>").choices(["lrc", "txt", "srt"]))
    .action(async (file: string, opts: { title?: string; artist?: string; format?: string }) => {
      const raw = await readFile(file, "utf8");
      const format = lyricsFormatFor(file, opts.format);
      const parsed = parseLyrics(raw, format);
      const { library } = await gated();
      const res = await library.createLyrics({ title: opts.title ?? parsed.meta.title ?? basename(file, extname(file)), artist: opts.artist, raw, format });
      emit({ id: res.article.id, title: res.article.title, lines: res.segments.length }, () => `Saved "${res.article.title}" (${res.segments.length} lines): ${res.article.id}`);
    });

  lyrics
    .command("list")
    .description("list saved lyrics")
    .option("--limit <n>", "maximum items", parseLimit, 100)
    .action(async (opts: { limit: number }) => {
      const { library } = await gated();
      const res = await library.listLyrics({ limit: opts.limit });
      emit(res, () => [`${res.total} songs`, ...res.items.map((l) => `${l.title}${l.artist ? ` — ${l.artist}` : ""}  (${l.id})`)]);
    });

  lyrics
    .command("show <id>")
    .description("show lyrics with translations")
    .action(async (id: string) => {
      const { library } = await gated();
      const res = await library.getLyrics(id);
      emit(res, () => [
        `${res.article.title}${res.meta?.artist ? ` — ${res.meta.artist}` : ""}`,
        "",
        ...res.segments.flatMap((s) => (s.translation ? [s.text, `  ${s.translation}`] : [s.text])),
      ]);
    });

  lyrics
    .command("export <id>")
    .description("export saved lyrics")
    .addOption(new Option("--format <format>", "output format").choices(["lrc", "md"]).default("lrc"))
    .option("--out <file>", "write to a file instead of stdout")
    .option("--no-translation", "original lines only")
    .action(async (id: string, opts: { format: "lrc" | "md"; out?: string; translation: boolean }) => {
      const { library } = await gated();
      const res = await library.getLyrics(id);
      const lines: TranslatedLine[] = res.segments.map((s) => ({
        startTime: s.startTime ?? null,
        endTime: s.endTime ?? null,
        text: s.text,
        translation: opts.translation ? (s.translation ?? null) : null,
      }));
      const artist = res.meta?.artist ?? undefined;
      const content =
        opts.format === "md" ? toMarkdown(res.article.title, lines, { artist }) : toBilingualLrc(lines, { title: res.article.title, ...(artist ? { artist } : {}) });
      if (opts.out) await writeFile(opts.out, content);
      if (json) emit({ id, format: opts.format, out: opts.out ?? null, content }, () => "");
      else if (opts.out) info(`Wrote ${opts.out}`);
      else deps.stdout(content);
    });

  // ---- articles -----------------------------------------------------------

  const article = program.command("article").description("reading articles");
  article
    .command("add")
    .description("add an article from a text/markdown file or a web page (text only)")
    .option("--file <path>")
    .option("--url <url>")
    .option("--title <title>")
    .action(async (opts: { file?: string; url?: string; title?: string }) => {
      if (!!opts.file === !!opts.url) throw usageError("pass exactly one of --file or --url");
      let title = opts.title;
      let content: string;
      if (opts.file) {
        content = await readFile(opts.file, "utf8");
        const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
        title ??= heading ?? basename(opts.file, extname(opts.file));
      } else {
        if (!/^https?:\/\//.test(opts.url!)) throw usageError("--url must be an http(s) URL");
        const res = await deps.fetch(opts.url!, { headers: { Accept: "text/html,text/plain;q=0.9" } });
        if (!res.ok) throw new CliError(EXIT.ERROR, "FETCH_FAILED", `could not fetch ${opts.url} (HTTP ${res.status})`);
        const body = await res.text();
        const isHtml = (res.headers.get("content-type") ?? "").includes("html") || /<html[\s>]/i.test(body);
        const extracted = isHtml ? htmlToText(body) : { title: null, text: body };
        content = extracted.text;
        title ??= extracted.title ?? new URL(opts.url!).hostname;
      }
      if (!content.trim()) throw usageError("the article is empty");
      const { library } = await gated();
      const res = await library.createArticle({ title: title!, content, ...(opts.url ? { sourceURL: opts.url } : {}) });
      emit({ id: res.article.id, title: res.article.title, segments: res.segments.length }, () => `Added "${res.article.title}" (${res.segments.length} sentences): ${res.article.id}`);
    });
  article
    .command("list")
    .description("list articles")
    .option("--limit <n>", "maximum items", parseLimit, 100)
    .action(async (opts: { limit: number }) => {
      const { library } = await gated();
      const res = await library.listArticles({ limit: opts.limit });
      emit(res, () => [`${res.total} articles`, ...res.items.map((a) => `${a.title}  (${a.id})`)]);
    });
  article
    .command("show <id>")
    .description("print an article with translations")
    .action(async (id: string) => {
      const { library } = await gated();
      const res = await library.getArticle(id);
      emit(res, () => [`# ${res.article.title}`, "", ...res.segments.map((s) => (s.translation ? `${s.text}\n  ${s.translation}` : s.text))]);
    });

  // ---- books --------------------------------------------------------------

  const book = program.command("book").description("books in your library");
  book
    .command("list")
    .description("list books")
    .action(async () => {
      const { library } = await gated();
      const res = await library.listBooks();
      emit(res, () => [`${res.total} books`, ...res.items.map((b) => `${b.title}${b.author ? ` — ${b.author}` : ""}  (${b.id})`)]);
    });
  book
    .command("chapters <bookId>")
    .description("list a book's chapters")
    .action(async (bookId: string) => {
      const { library } = await gated();
      const res = await library.listChapters(bookId);
      emit(res, () => [`${res.book.title}: ${res.total} chapters`, ...res.items.map((c) => `${String(c.index + 1).padStart(3)}. ${c.title ?? "(untitled)"}  (${c.articleId})`)]);
    });

  book
    .command("import <file>")
    .description("import an .epub or .txt book (parsed locally, synced to all devices)")
    .action(async (file: string) => {
      if (!/\.(epub|txt)$/i.test(file)) throw usageError("only .epub and .txt books are supported");
      const bytes = new Uint8Array(await readFile(file));
      const ctx = await gated();
      const res = await importBook(
        { client: ctx.client, tokenStore: ctx.auth.tokenStore, fetch: deps.fetch, now: deps.now, onProgress: json ? undefined : info },
        bytes,
        basename(file),
      );
      emit(res, () => `Imported "${res.title}" (${res.chapters} chapters): ${res.bookId}`);
    });
  book
    .command("translate <bookId>")
    .description("translate chapters with hosted AI in the background (spends AI credits)")
    .requiredOption("--to <lang>", "target language code, e.g. zh")
    .option("--chapters <ranges>", "1-based chapter ranges, e.g. 1-5,8 (default: all)")
    .option("--watch", "wait and show progress until the job finishes")
    .action(async (bookId: string, opts: { to: string; chapters?: string; watch?: boolean }) => {
      if (!/^[A-Za-z-]{2,12}$/.test(opts.to)) throw usageError("--to must be a language code like zh or en");
      const { library } = await gated();
      let chapters: string[] | undefined;
      if (opts.chapters) {
        const list = await library.listChapters(bookId);
        let indexes: number[];
        try {
          indexes = parseChapterRanges(opts.chapters, list.total);
        } catch (err) {
          throw usageError((err as Error).message);
        }
        chapters = indexes.map((i) => list.items[i]?.articleId).filter((id): id is string => !!id);
        if (!chapters.length) throw usageError(`no chapters match ${opts.chapters} (the book has ${list.total})`);
      }
      const job = await library.createTranslateBookJob({ bookId, targetLanguage: opts.to, chapters });
      if (opts.watch) return watchJob(library, job.id);
      emit(job, () => [`Queued job ${job.id} (${job.total} chapters).`, `Follow it with: koto job status ${job.id} --watch`]);
    });

  // ---- jobs ---------------------------------------------------------------

  const TERMINAL = new Set(["done", "failed", "canceled", "paused"]);
  const jobLine = (j: Job) => `${j.id}  ${j.kind}  ${j.status}  ${j.progress}/${j.total}${j.error ? `  (${j.error})` : ""}`;
  const watchJob = async (library: LibraryClient, id: string) => {
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let job = await library.getJob(id);
    let last = "";
    while (!TERMINAL.has(job.status)) {
      const line = jobLine(job);
      if (line !== last && !json) info(line);
      last = line;
      await sleep(3000);
      job = await library.getJob(id);
    }
    emit(job, () => jobLine(job));
    if (job.status === "failed") throw new CliError(EXIT.ERROR, "JOB_FAILED", `job ${id} failed${job.error ? `: ${job.error}` : ""}`);
    if (job.status === "paused" && job.error === "INSUFFICIENT_CREDITS") throw new CliError(EXIT.PLAN, "INSUFFICIENT_CREDITS", "job paused: not enough AI credits");
  };

  const jobCmd = program.command("job").description("background jobs (book translation)");
  jobCmd
    .command("list")
    .description("recent jobs")
    .action(async () => {
      const { library } = await gated();
      const res = await library.listJobs();
      emit(res, () => (res.jobs.length ? res.jobs.map(jobLine) : "No jobs."));
    });
  jobCmd
    .command("status <id>")
    .description("show a job's progress")
    .option("--watch", "poll until the job finishes")
    .action(async (id: string, opts: { watch?: boolean }) => {
      const { library } = await gated();
      if (opts.watch) return watchJob(library, id);
      const job = await library.getJob(id);
      emit(job, () => jobLine(job));
    });
  jobCmd
    .command("cancel <id>")
    .description("cancel a queued or running job")
    .action(async (id: string) => {
      const { library } = await gated();
      emit(await library.cancelJob(id), () => `Canceled ${id}`);
    });

  // ---- API keys -----------------------------------------------------------

  const keys = program.command("keys").description("API keys for scripts, CI and MCP (Plus)");
  keys
    .command("list")
    .description("list active API keys")
    .action(async () => {
      const { client } = await gated();
      const res = await client.apiKeys.list();
      emit(res, () =>
        res.keys.length
          ? res.keys.map((k) => `${k.id}  ${k.prefix}…  ${k.name}  [${k.scopes.join(",")}]${k.expiresAt ? `  expires ${k.expiresAt.slice(0, 10)}` : ""}`)
          : "No API keys.",
      );
    });
  keys
    .command("create")
    .description("create an API key (the secret is shown once)")
    .option("--name <name>", "label", "koto CLI")
    .option("--scopes <scopes>", "comma separated, e.g. vocab:read,library:read", "vocab:read,library:read")
    .option("--expires-days <n>", "expire after N days", parseLimit)
    .action(async (opts: { name: string; scopes: string; expiresDays?: number }) => {
      const { client } = await gated();
      const scopes = opts.scopes.split(",").map((s) => s.trim()).filter(Boolean);
      const key = await client.apiKeys.create({ name: opts.name, scopes, ...(opts.expiresDays ? { expiresInDays: opts.expiresDays } : {}) });
      emit(key, () => [`Created ${key.name} [${key.scopes.join(",")}] — copy it now, it will not be shown again:`, key.key]);
    });
  keys
    .command("revoke <id>")
    .description("revoke an API key")
    .action(async (id: string) => {
      const { client } = await gated();
      await client.apiKeys.revoke(id);
      emit({ ok: true, id }, () => `Revoked ${id}`);
    });

  // ---- search -------------------------------------------------------------

  program
    .command("search <query>")
    .description("search books, articles, lyrics and vocabulary")
    .option("--types <types>", "comma separated: book,article,lyrics,vocab")
    .option("--limit <n>", "maximum hits", parseLimit, 20)
    .action(async (query: string, opts: { types?: string; limit: number }) => {
      const { library } = await gated();
      const res = await library.search(query, { types: opts.types?.split(","), limit: opts.limit });
      emit(res, () => [`${res.total} hits`, ...res.items.map((h) => `[${h.kind}] ${h.title}${h.subtitle ? ` — ${h.subtitle}` : ""}  (${h.id})`)]);
    });

  // ---- run ----------------------------------------------------------------

  try {
    await program.parseAsync(argv, { from: "user" });
    return EXIT.OK;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") return EXIT.OK;
      if (json) print(JSON.stringify({ error: { code: "USAGE", message: err.message, exitCode: EXIT.USAGE } }, null, 2));
      return EXIT.USAGE;
    }
    const e = toCliError(err);
    if (json) print(JSON.stringify({ error: { code: e.code, message: e.message, exitCode: e.exitCode } }, null, 2));
    else info(`koto: ${e.message}`);
    return e.exitCode;
  }
}
