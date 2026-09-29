---
title: はじめに
description: OpenKoto とは何か、何ができるか、そして始め方。
---

## OpenKoto とは？

OpenKoto は、**オープンソースの AI 搭載言語学習アプリ**です。決められたカリキュラムではなく、本当に好きなコンテンツ —— 小説、歌詞、記事 —— から学び、出会った単語をスケジュールに沿って復習できる単語カードにします。

OpenKoto は **Web**（[openkoto.com](https://openkoto.com)）、**iOS / iPadOS**、**macOS**、**Windows**、**Linux** で利用できます。アカウントなしでもローカル機能はすべて使え、デバイス間で学習データを持ち歩きたいときにサインインして同期できます。

> 🎯 **こんな方におすすめ**：日本語学習者、英語学習者、多言語話者、そして好きなコンテンツで言語を学びたいすべての方。

## 主な機能

- 🧠 **FSRS による単語復習** —— 読みながら単語を保存し、最新の間隔反復アルゴリズム FSRS で復習。もう一度 / 難しい / 良い / 簡単、取り消しにも対応。
- 📚 **小説リーディング** —— **EPUB**・**TXT** の本をインポートし、章ごとに読み、一文ずつ AI 翻訳と解説。しおりと読書進捗も同期。
- 🎵 **歌詞で学ぶ** —— **LRC** 歌詞をインポートし、一行ずつ訳を確認しながら、タイミングに合わせて一緒に歌えます。
- 🔄 **マルチデバイス同期** —— 単語、復習記録、本、歌詞、進捗を Web・iOS・macOS・Windows 間で同期。
- 🤖 **CLI・MCP・エージェントスキル** —— `koto` CLI、OpenKoto MCP サーバー、エージェントスキルにより、AI エージェント（Claude など）が単語の復習、ライブラリの閲覧、歌詞翻訳の保存を行えます。
- 🔑 **自分の API キー、またはホスト型 AI** —— 自分の AI プロバイダー（Google AI Studio、302.AI、Kimi、OpenAI 互換エンドポイント）を使うことも、有料プランでホスト型 AI を使うこともできます。
- 🆓 **オープンソース** —— Apache 2.0 ライセンス。[GitHub](https://github.com/hikariming/openkoto) でオープンに開発しています。

## なぜ OpenKoto？

| 機能 | OpenKoto | 従来のアプリ |
|------|----------|--------------|
| 📖 あらゆるコンテンツから学習 | ✅ 本、歌詞、記事 | ❌ 固定カリキュラム |
| 🧠 科学的な復習 | ✅ FSRS 間隔反復 | ⚠️ 単純な連続記録が多い |
| 🔒 プライバシー重視 | ✅ ローカルファースト、同期は任意 | ❌ クラウド依存 |
| 🆓 オープンソース | ✅ Apache 2.0 | ❌ クローズドソース |
| 💻 すべてのデバイス | ✅ Web、iOS、macOS、Windows、Linux | ⚠️ モバイルのみが多い |
| 🤖 エージェント対応 | ✅ CLI + MCP + スキル | ❌ API なし |

## はじめよう

1. **アプリを選ぶ**：Web 版 [openkoto.com](https://openkoto.com) を使うか、[GitHub Releases](https://github.com/hikariming/openkoto/releases) からデスクトップ版をダウンロード、または App Store で **「OpenKoto」** を検索。
2. **AI を設定する**：以下のガイドに沿って自分の API キーを追加するか、サブスクリプションでホスト型 AI を利用。
3. **好きなコンテンツをインポート**：EPUB/TXT の小説や LRC の曲を読み込んで、単語を集め始めましょう。

AI プロバイダーガイド：

- [Google AI Studio API キーの取得](/docs/google-ai-studio) —— Gemini モデルを無料で利用
- [302.AI API キーの取得](/docs/302ai) —— 豊富なモデルを従量課金で
- [Kimi K2.5 API キーの取得](/docs/kimi-k2) —— Moonshot AI の Kimi モデル

### CLI とエージェント

```bash
npm i -g @openkoto/cli
koto login
```

リモート MCP サーバーは `https://openkoto.com/mcp` で利用できます。詳しくは [スキルの README](https://github.com/hikariming/openkoto/tree/main/skills/openkoto) をご覧ください。

## トラブルシューティング

### macOS: 「App is damaged and can't be opened」

これは macOS Gatekeeper の影響です。ターミナルで以下を実行してください：

```bash
sudo xattr -r -d com.apple.quarantine /Applications/OpenKoto\ Desktop.app
```
