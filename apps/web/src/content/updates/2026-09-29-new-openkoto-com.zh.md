---
title: openkoto.com 现在就是 OpenKoto 网页版
description: 官网、文档和网页版应用合而为一，支持账号登录与多端同步。
date: 2026-09-29
tags: 官网, 网页版, 同步
---

openkoto.com 过去是一个介绍网站，现在它就是 **OpenKoto 网页版应用**本身，文档、更新日志和法律页面也一并迁移了进来。

### 网页版新功能

- **背单词**：基于 FSRS 间隔重复算法
- **读小说**：导入 EPUB、TXT 书籍，边读边看 AI 翻译
- **学歌词**：导入 LRC 歌词，逐行学习，跟唱
- **AI 助手**：可以直接使用你的书库和生词本

### 账号与同步

- 支持邮箱、Google、Apple、GitHub 登录
- 生词、复习记录、书籍、歌词和阅读进度在网页、iOS、macOS、Windows 间同步
- 可选 [Plus / Pro 会员](/pricing)：无限同步、托管 AI 与命令行工具

### 面向开发者与 Agent

- `koto` 命令行（`npm i -g @openkoto/cli`）
- 远程 MCP 服务器：`https://openkoto.com/mcp`
- 适用于 Claude Code 等 Agent 的技能包

### 页面迁移

- `/privacy-policy` → [/privacy](/privacy)，`/terms-of-service` → [/terms](/terms)
- 带语言前缀的地址（如 `/zh/docs`）会跳转到 [/docs](/docs)，语言跟随你的设置
- 隐私政策与服务条款已补充账号、同步与支付相关内容
