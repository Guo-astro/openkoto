---
title: Introduction
description: What OpenKoto is, what it can do, and how to get started.
---

## What is OpenKoto?

OpenKoto is an **open-source, AI-powered language-learning app**. Instead of a fixed curriculum, you learn from content you actually enjoy — novels, song lyrics, articles — and turn the words you meet into flashcards you review on a schedule.

OpenKoto runs on the **web** ([openkoto.com](https://openkoto.com)), **iOS / iPadOS**, **macOS**, **Windows** and **Linux**. Everything works locally without an account; sign in when you want your library to follow you across devices.

> 🎯 **Perfect for**: Japanese learners, English learners, polyglots, and anyone who wants to learn through content they love.

## Core features

- 🧠 **Vocabulary review with FSRS** — save words while you read, then review them with the modern FSRS spaced-repetition algorithm. Again / Hard / Good / Easy, with undo.
- 📚 **Novel reading** — import **EPUB** and **TXT** books, read chapter by chapter, and get AI translation and explanations sentence by sentence. Bookmarks and reading progress sync.
- 🎵 **Lyrics learning** — import **LRC** lyrics, see line-by-line translations and sing along with synced timing.
- 🔄 **Multi-device sync** — words, reviews, books, lyrics and progress stay in sync across web, iOS, macOS and Windows.
- 🤖 **CLI, MCP and agent skill** — the `koto` CLI, the OpenKoto MCP server and an agent skill let AI agents (such as Claude) review words, read your library and save lyrics translations.
- 🔑 **Bring your own key, or use hosted AI** — use your own AI provider (Google AI Studio, 302.AI, Kimi, any OpenAI-compatible endpoint), or the built-in hosted AI on a paid plan.
- 🆓 **Open source** — Apache 2.0 licensed, developed in the open on [GitHub](https://github.com/hikariming/openkoto).

## Why OpenKoto?

| Feature | OpenKoto | Traditional apps |
|---------|----------|------------------|
| 📖 Learn from any content | ✅ Books, lyrics, articles | ❌ Fixed curriculum |
| 🧠 Scientific review | ✅ FSRS spaced repetition | ⚠️ Often simple streaks |
| 🔒 Privacy-focused | ✅ Local-first, sync is optional | ❌ Cloud-only |
| 🆓 Open source | ✅ Apache 2.0 | ❌ Closed source |
| 💻 Every device | ✅ Web, iOS, macOS, Windows, Linux | ⚠️ Often mobile only |
| 🤖 Agent friendly | ✅ CLI + MCP + skill | ❌ No API |

## Get started

1. **Pick your app**: use the web app at [openkoto.com](https://openkoto.com), download the desktop app from [GitHub Releases](https://github.com/hikariming/openkoto/releases), or search for **“OpenKoto”** on the App Store.
2. **Set up AI**: add your own API key, following one of the guides below, or subscribe to use hosted AI.
3. **Import something you love**: an EPUB/TXT novel or an LRC song, and start collecting words.

AI provider guides:

- [Get a Google AI Studio API key](/docs/google-ai-studio) — free access to Gemini models
- [Get a 302.AI API key](/docs/302ai) — a wide range of models, pay as you go
- [Get a Kimi K2.5 API key](/docs/kimi-k2) — Moonshot AI's Kimi models

### CLI and agents

```bash
npm i -g @openkoto/cli
koto login
```

The remote MCP server is available at `https://openkoto.com/mcp`. See the [skill README](https://github.com/hikariming/openkoto/tree/main/skills/openkoto) for details.

## Troubleshooting

### macOS: "App is damaged and can't be opened"

This is caused by macOS Gatekeeper. Run in Terminal:

```bash
sudo xattr -r -d com.apple.quarantine /Applications/OpenKoto\ Desktop.app
```
