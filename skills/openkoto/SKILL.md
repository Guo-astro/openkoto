---
name: openkoto
description: Use the user's OpenKoto language-learning account from the terminal via the `koto` CLI — review due vocabulary (FSRS), add words to word packs, translate and save song lyrics (LRC), add articles, and browse books. Use when the user mentions OpenKoto/koto, their vocabulary or flashcards, lyrics translation, or their reading library.
---

# Purpose

OpenKoto is a language-learning app (iOS / desktop / web) that syncs the user's vocabulary cards, word packs, articles, song lyrics and books through the cloud. The `koto` CLI reads and writes that cloud library directly, so every change shows up on all of the user's devices right away.

Always drive the CLI with `--json` and parse stdout. Never scrape the human-readable output.

# Hard Rules

- Pass `--json` on every command. On success stdout is one JSON document. On failure stdout is `{"error":{"code","message","exitCode"}}` and the process exits non-zero.
- Check the exit code first:
  - `0` ok
  - `2` usage error: fix the arguments
  - `3` not logged in: ask the user to run `koto login`; don't try to log in for them
  - `4` plan or quota: tell the user; the CLI needs OpenKoto Plus, and free accounts have storage limits. Don't retry
  - `1` anything else: report the message
- Changes are real and sync to all devices. Before a bulk write (import, more than ~10 adds, overwriting translations), confirm with the user. There is no bulk-delete command; `koto vocab rm <id>` deletes one card. Only use it when the user asks.
- Ids are opaque strings. Always take them from previous `--json` output, never invent them.
- Never print or log `byok.api_key` or `KOTO_API_KEY`.
- Don't run `koto vocab review`. It is an interactive TTY session for humans. To review with the user, use `vocab due` and `vocab grade` (see workflows/daily-review.md).

# Setup check

```bash
koto whoami --json      # exit 3 → not logged in; entitlements.cli false → needs Plus
```

If `koto` is missing: `npm i -g @openkoto/cli`, then the user runs `koto login`. The login prints a code and opens the browser. For CI or headless use, set `KOTO_API_KEY=ok_live_…`, created at openkoto.app → Settings → API keys.

# Command reference

| Task | Command | JSON result |
|---|---|---|
| Account | `koto whoami --json` | `{userId,email,plan,entitlements:{cli,hostedAi,…},credits,apiBase,auth}` |
| Due cards | `koto vocab due [--limit N] [--pack P] --json` | `{items:[Vocab],total,date}` |
| List / search cards | `koto vocab list [--pack P] [-q text] [--limit N] --json` | `{items:[Vocab],total}` |
| Add word | `koto vocab add <word> [-m meaning] [-r reading] [-e example] [--pack P] [--from articleId] --json` | `{vocab,created,deduped}` (duplicates merge, never error) |
| Grade one review | `koto vocab grade <id> <1-4> --json` | `{vocab,event}`. Grades: 1 again, 2 hard, 3 good, 4 easy |
| Delete card | `koto vocab rm <id> --json` | `{ok,id}` |
| Import CSV | `koto vocab import words.csv [--pack P] --json` | `{imported,deduped,failed:[…],stoppedEarly}` |
| Translate lyrics | `koto lyrics translate song.lrc --to zh [--byok] [--save] [--out f] --json` | `{title,artist,targetLanguage,format,engine,aligned,lines:[{startTime,endTime,text,translation}],saved:{id}\|null,out}` |
| Save lyrics | `koto lyrics add song.lrc [--title T] [--artist A] --json` | `{id,title,lines}` |
| List lyrics | `koto lyrics list --json` | `{items:[{id,title,artist,preview}],total}` |
| Show lyrics | `koto lyrics show <id> --json` | `{article,segments:[{order,text,translation,startTime,endTime}],meta}` |
| Export lyrics | `koto lyrics export <id> --format lrc\|md [--out f] [--no-translation] --json` | `{id,format,out,content}` |
| Add article | `koto article add --file a.md \| --url https://… [--title T] --json` | `{id,title,segments}` |
| Articles | `koto article list --json`, `koto article show <id> --json` | `{items,total}` / `{article,segments}` |
| Books | `koto book list --json`, `koto book chapters <bookId> --json` | `{items,total}` / `{book,items:[{index,title,articleId}],total}` |
| Read a chapter | `koto article show <chapterArticleId> --json` | `{article,segments}` |
| Search everything | `koto search <query> [--types book,article,lyrics,vocab] --json` | `{items:[{kind,id,title,subtitle}],total}` |
| Settings | `koto config get --json`, `koto config set <key> [value]` | keys: `api_base`, `byok.base_url`, `byok.api_key`, `byok.model` |

A `Vocab` object has these fields: `id, word, meaning, reading?, example?, usage?, srsState ("new"|"learning"|"review"), dueDate (YYYY-MM-DD), reviewCount, stability, difficulty, lastReviewedAt?, suspendedAt?, packIds[]`.

## Lyrics translation engines

- `--byok` translates locally with the user's own OpenAI-compatible provider (`koto config set byok.base_url|byok.api_key|byok.model`). It costs no OpenKoto credits and works without calling the API unless `--save` is given.
- Without `--byok` the CLI uses hosted AI, which needs Pro or AI credits. When that is unavailable it exits `4` (or `1` with `HOSTED_AI_NOT_AVAILABLE_YET`). Suggest `--byok`.
- If `aligned` is `false`, some `translation` values are empty. Fill them in yourself, then write them back with `koto lyrics translate … --save`, or use the MCP tool `save_lyrics_translation`.
- You can also translate the lines yourself: read the lines with `koto lyrics show <id> --json`, then save them with the MCP tool `save_lyrics_translation`.

# Workflows

- `workflows/lyrics-study.md`: translate a song, then pick vocabulary into a word pack
- `workflows/novel-reading.md`: browse a book, read or summarise chapters, save words
- `workflows/daily-review.md`: run today's review conversationally and report progress

# MCP alternative

If the `openkoto` MCP server is configured (see README.md), prefer its tools: `search_library`, `list_due_vocab`, `add_vocab`, `review_vocab`, `get_lyrics`, `save_lyrics_translation`, `create_lyrics`, `list_books`. They return the same JSON shapes.
