---
title: 简介
description: OpenKoto 是什么、能做什么，以及如何开始使用。
---

## 什么是 OpenKoto？

OpenKoto 是一款**开源的、AI 驱动的语言学习应用**。它不给你固定课程，而是让你从真正喜欢的内容里学习 —— 小说、歌词、文章 —— 并把遇到的生词变成按计划复习的单词卡。

OpenKoto 支持**网页**（[openkoto.com](https://openkoto.com)）、**iOS / iPadOS**、**macOS**、**Windows** 和 **Linux**。不登录也能使用全部本地功能；想让学习数据跟着你走时，再登录开启同步。

> 🎯 **适合人群**：日语学习者、英语学习者、多语言爱好者，以及任何想通过自己喜欢的内容学语言的人。

## 核心功能

- 🧠 **FSRS 背单词** —— 阅读时收藏生词，用新一代 FSRS 间隔重复算法复习。重来 / 困难 / 良好 / 简单，支持撤销。
- 📚 **读小说** —— 导入 **EPUB**、**TXT** 书籍，按章节阅读，逐句 AI 翻译与讲解。书签和阅读进度自动同步。
- 🎵 **学歌词** —— 导入 **LRC** 歌词，逐行对照翻译，跟着时间轴一起唱。
- 🔄 **多端同步** —— 生词、复习记录、书籍、歌词和进度在网页、iOS、macOS、Windows 之间保持同步。
- 🤖 **CLI、MCP 与 Agent 技能** —— `koto` 命令行、OpenKoto MCP 服务器和 Agent 技能，让 AI 助手（如 Claude）帮你复习单词、读你的书库、保存歌词翻译。
- 🔑 **自带 Key 或使用托管 AI** —— 可以使用自己的 AI 服务（Google AI Studio、302.AI、Kimi 或任何 OpenAI 兼容接口），也可以在付费套餐中直接使用内置托管 AI。
- 🆓 **开源** —— 采用 Apache 2.0 许可证，在 [GitHub](https://github.com/hikariming/openkoto) 上公开开发。

## 为什么选择 OpenKoto？

| 特性 | OpenKoto | 传统应用 |
|------|----------|----------|
| 📖 从任何内容学习 | ✅ 书籍、歌词、文章 | ❌ 固定课程 |
| 🧠 科学复习 | ✅ FSRS 间隔重复 | ⚠️ 多为简单打卡 |
| 🔒 隐私优先 | ✅ 本地优先，同步可选 | ❌ 只能依赖云端 |
| 🆓 开源 | ✅ Apache 2.0 | ❌ 闭源 |
| 💻 全平台 | ✅ 网页、iOS、macOS、Windows、Linux | ⚠️ 多为仅手机 |
| 🤖 对 Agent 友好 | ✅ CLI + MCP + 技能 | ❌ 没有 API |

## 开始使用

1. **选择客户端**：直接使用网页版 [openkoto.com](https://openkoto.com)，从 [GitHub Releases](https://github.com/hikariming/openkoto/releases) 下载桌面端，或在 App Store 搜索 **“OpenKoto”**。
2. **配置 AI**：按下方指南添加自己的 API Key，或订阅后使用托管 AI。
3. **导入你喜欢的内容**：一本 EPUB/TXT 小说或一首 LRC 歌曲，开始收集生词。

AI 服务商指南：

- [获取 Google AI Studio API Key](/docs/google-ai-studio) —— 免费使用 Gemini 模型
- [获取 302.AI API Key](/docs/302ai) —— 模型丰富，按量付费
- [获取 Kimi K2.5 API Key](/docs/kimi-k2) —— 月之暗面的 Kimi 模型

### 命令行与 Agent

```bash
npm i -g @openkoto/cli
koto login
```

远程 MCP 服务器地址为 `https://openkoto.com/mcp`。详见 [技能说明](https://github.com/hikariming/openkoto/tree/main/skills/openkoto)。

## 常见问题

### macOS：“应用已损坏，无法打开”

这是由 macOS Gatekeeper 的安全机制导致的。请在终端运行：

```bash
sudo xattr -r -d com.apple.quarantine /Applications/OpenKoto\ Desktop.app
```
