---
title: Google AI Studio APIキーの取得
description: Google AI Studio APIキーを無料で取得し、OpenKotoで使用する方法を学びます。
---

## はじめに

Google AI Studioは、強力なGeminiモデルへの無料アクセスを提供しています。このガイドでは、APIキーを取得し、OpenKotoで設定する方法を説明します。

最高の体験を得るために、**Gemini 3 Pro** と **Gemini 3 Flash** の両方のモデルをシステムに追加することを強くお勧めします。

## ステップ 1: Google AI Studio にアクセス

[Google AI Studio](https://aistudio.google.com/) にアクセスし、Googleアカウントでログインします。

![Google AI Studio ホーム](/docs/aistudio/aistudio-home.png)

## ステップ 2: APIキーの作成

左上の「Get API key」ボタン、またはメインビューの「Create API key」をクリックします。

![APIキー作成ボタン](/docs/aistudio/create-key-button.png)

既存のプロジェクトがない場合は、「Create APIキー in new project」（新しいプロジェクトでAPIキーを作成）を選択します。

![キー作成ダイアログ](/docs/aistudio/creat-key.png)

## ステップ 3: キーのコピー

生成されたら、APIキーをコピーします。

![キーをコピー](/docs/aistudio/cpoy-key.png)

## ステップ 4: OpenKoto での設定

OpenKotoを開き、**設定 > モデルプロバイダー** に移動して、**Google AI Studio** を選択します。APIキーを貼り付けます。

![OpenKotoでキーを追加](/docs/aistudio/add-key-in-openkoto.png)

## モデルの推奨事項

以下の2つの主要モデルを構成に追加することを強くお勧めします：

### Gemini 3 Pro
- **特徴**: 複雑なタスク、深い推論、長いコンテキストの理解に最適です。
- **使用例**: 長い章の読解、高難易度の学習タスク、複雑な問題解決。

### Gemini 3 Flash
- **特徴**: 非常に高速で効率的です。
- **使用例**: 記事、論文、小説の読書など、日常的な多くのシナリオに適しています。
