<div align="center">

<!-- <img src="/docs/img/logo.png" alt="OpenKoto Logo" height="140"> -->

# OpenKoto Desktop 📕

**Open Source Language Learning Tool | Free Alternative to Language Reactor & Duolingo**

<p align="center">
  <a href="https://tauri.app" target="_blank"><img src="https://img.shields.io/badge/Tauri-v2-blue.svg" alt="Tauri"></a>
  <a href="https://github.com/hikariming/OpenKoto/stargazers" target="_blank"><img src="https://img.shields.io/github/stars/hikariming/OpenKoto.svg" alt="GitHub stars"></a>
  <a href="https://github.com/hikariming/OpenKoto/blob/main/LICENSE" target="_blank"><img src="https://img.shields.io/badge/license-Apache%202.0-green.svg" alt="License"></a>
</p>

[**English**](/README.md)｜[**中文**](/README_cn.md)｜[**日本語**](/README_ja.md)

</div>

🌐 **Official Website & Documentation**: [openkoto.com](https://openkoto.com/)

> 🎉 **New**: The **OpenKoto iOS app is now live on the App Store!** Read articles and books, study videos with subtitles, and review vocabulary with spaced repetition — right on your iPhone or iPad. Search for **“OpenKoto”** on the App Store to download it. <!-- TODO: replace with direct App Store link -->

> 📢 **Note**: This project was previously known as **TextLingo**. We've renamed it to **OpenKoto** (Open + 言/ことば, meaning "word" in Japanese) to better reflect our vision of open-source reading, translation, and language learning.

## What is OpenKoto?

OpenKoto Desktop is an **open-source, AI-powered language learning application** that transforms any content you're interested in into an immersive learning experience. Beyond language learning, it also serves as a **powerful reader and translation tool**. Unlike traditional language learning apps, OpenKoto lets you learn from **real-world content** — song lyrics, news articles, blog posts, or any text that sparks your interest.

Built with **Tauri + React + Rust**, it runs locally on your machine for **fast performance and complete privacy**. A **native iOS app** for iPhone and iPad is also available on the App Store.

> 🎯 **Perfect for**: Japanese learners, English learners, polyglots, and anyone who wants to learn languages through content they actually enjoy!

![OpenKoto Main Interface](img/openkoto_video.png)

## Why OpenKoto?

| Feature | OpenKoto | Traditional Apps |
|---------|-----------|------------------|
| 📖 Learn from any content | ✅ Import URLs, docs, lyrics | ❌ Fixed curriculum |
| 🔒 Privacy-focused | ✅ 100% local processing | ❌ Cloud-dependent |
| 🆓 Free & open source | ✅ Apache 2.0 License | ❌ Subscription-based |
| 🌍 100+ languages supported | ✅ Learning & transcription | ❌ Limited languages |
| 🖥️ Native desktop performance | ✅ Tauri + Rust | ❌ Web-based lag |
| 🤖 AI-powered explanations | ✅ Smart context analysis | ❌ Limited feedback |

## Download

| Version | Description | Link |
|---------|-------------|------|
| **iOS** | **New!** 📱 Native app for iPhone & iPad — reading, on-device furigana/pinyin, video subtitles, SRS review, privacy-first | Search **“OpenKoto”** on the App Store <!-- TODO: replace with direct App Store link --> |
| **Desktop** | **Recommended** 🖥️ Native performance, local data, Mac/Windows/Linux | [Download Latest Release](https://github.com/hikariming/OpenKoto/releases) |
| Web | **Being rebuilt**: vocabulary review, novels and lyrics, synced with iOS and desktop (launching at openkoto.com) | — |
| CLI / Agents | `koto` CLI, MCP server and agent skill so AI agents can work with your library (Plus) | [skills/openkoto](skills/openkoto) |
| Source Code | 🆓 Fully open source, Apache 2.0 License | [GitHub Repository](https://github.com/hikariming/OpenKoto) |


## OpenKoto for iOS 📱

The iOS app brings the same "learn from content you love" experience to iPhone and iPad — offline-first and privacy-focused:

- 📖 Import articles (paste, TXT, Markdown, web) and **TXT / EPUB books** with automatic chapter splitting
- 🎬 Study video & audio with **SRT / VTT subtitles** — sentence-by-sentence follow, single-sentence loop, pitch-preserving speed control, and blind-listening shadowing; generate subtitles on device (iOS 26)
- 🈶 **Word-level readings** above Japanese and Chinese text (furigana / pinyin), generated entirely on device
- 📝 Vocabulary packs with **spaced-repetition (SRS) review**, plus full-text search across everything you've imported
- 🤖 Optional **BYOK AI** translation and sentence explanations — your API key stays in the iOS Keychain, learning data stays on your device
- 🌐 UI in English, Simplified Chinese, and Japanese; no account required

## Core Features

- 🎯 **Smart Support** - One-click import from URLs, **PDF, EPUB, TXT**, Word, Markdown with automatic translation and vocabulary extraction
- 📖 **Immersive Reading Mode**
  - Professional reader interface for articles and books
  - Real-time language switching
  - Instant word lookup and grammar parsing
- 🔍 **AI Learning Assistant**
  - Intelligent word explanations in context
  - Detailed grammar breakdowns (Chinese-Japanese-English)
  - Pronunciation guidance and correction
- 📝 **Interactive AI Q&A** - Highlight and ask questions about any text in real-time

## Use Cases 🎬

- 📚 **Study with Any Material** - Import PDFs, EPUB books, or TXT files for deep reading and analysis
- 🎵 **Learn Japanese through Song Lyrics** - Master pronunciation for your favorite J-Pop songs and concerts
- 📰 **Read News in Foreign Languages** - The Economist, NHK News, and more with instant translations
- 🎬 **Anime Learning** - Understand your favorite Japanese anime with transcription support

## Coming Soon

- 📚 Personalized vocabulary and grammar exercise system
- 🎥 YouTube video learning support

## Getting Started

### Prerequisites
- Node.js (v18+)
- Rust

### Development Setup

1. **Clone and download binaries** (ffmpeg & yt-dlp for video features):
   ```bash
   git clone https://github.com/hikariming/OpenKoto.git
   cd OpenKoto
   chmod +x script/download_binaries.sh
   ./script/download_binaries.sh
   ```

2. **Install dependencies**:
   ```bash
   cd textlingo-desktop
   npm install
   ```

   **Option A: Core Application Only** (Faster, no PDF sidecar)
   ```bash
   npm run tauri dev
   ```

   **Option B: Full Application with PDF Sidecar** (Recommended for PDF translation)
   This script handles the Python environment, dependencies, and bundled PDF sidecar setup automatically.
   ```bash
   # Make sure you are in the root directory
   chmod +x dev.sh
   ./dev.sh
   ```

For more details, see [Development Documentation](docs/HowToRun_en.md).

## Troubleshooting

### macOS: "App is damaged and can't be opened"
This is due to macOS Gatekeeper. Run in Terminal:
```bash
sudo xattr -r -d com.apple.quarantine /Applications/OpenKoto\ Desktop.app
```

## Supported Languages

**100+ languages supported** for learning and transcription, including:

- 🇯🇵 Japanese (with furigana support and auto grammar analysis)
- 🇺🇸 English
- 🇨🇳 Chinese (Simplified & Traditional)
- 🇰🇷 Korean
- 🇫🇷 French
- 🇩🇪 German
- 🇪🇸 Spanish
- 🇮🇹 Italian
- 🇵🇹 Portuguese
- And many more...

PRs welcome for additional language support!

## Tech Stack

- **Frontend**: React + TypeScript + Tailwind CSS
- **Backend**: Tauri + Rust
- **AI**: OpenAI-compatible API integration

## Contributing

We welcome contributions! Please feel free to submit PRs or open issues.

## Current Version

**v0.1.4** (Development)

## Related Projects by the Author

### Japanese AI Navigation Station
[aitoolsjapan](https://aitoolsjapan.com/) is a Japanese AI navigation website. Here, you can discover a wide range of AI-related tools and resources from Japan. It serves as a convenient hub to quickly find the AI services and applications you need, whether you're exploring cutting-edge AI technologies or looking for practical AI-powered tools.

### Dify Usage and Learning Sharing Platform
[usedify](https://usedify.app/) is a specialized platform dedicated to the usage and learning of Dify. On this site, you can access a wealth of valuable content, including Dify usage tips, hands-on experience sharing, and practical case studies. Whether you're a beginner getting started with Dify or an experienced user aiming to master advanced features, usedify provides the knowledge and insights to help you make the most of the Dify tool.

### Foreign Language Learning Site Based on Personalized Texts
[openkoto](https://openkoto.com/) is a platform that enables foreign language learning based on texts that interest you. Instead of traditional language learning materials, it allows you to leverage your personal interests, such as favorite novels, articles, or blogs, as study resources. This unique approach makes language learning more engaging and effective, helping you improve your language proficiency while exploring topics you love.

## License

Apache License 2.0 - See [LICENSE](LICENSE) for details

---

<div align="center">

**⭐ Star this repo if OpenKoto helps you learn languages! ⭐**

[Report Bug](https://github.com/hikariming/OpenKoto/issues) · [Request Feature](https://github.com/hikariming/OpenKoto/issues) · [Join Discussion](https://github.com/hikariming/OpenKoto/discussions)

</div>
