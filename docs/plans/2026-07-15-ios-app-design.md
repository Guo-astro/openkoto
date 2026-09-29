# OpenKoto iOS 原生应用设计文档

> 日期：2026-07-15
> 状态：评审修订版（可用于一期拆票；同步与商业化仍需单独 RFC）
> 范围：iOS APP 三阶段路线设计；一期（本地核心功能）为详细设计，二/三期（同步与商业化）为架构草案

---

## 1. 背景与目标

OpenKoto 桌面版（`textlingo-desktop/`，Tauri 2 + React 19 + Rust）已实现"素材导入 → 句子切分 → AI 逐句翻译/精讲 → 生词收藏 + SRS 复习（2026-07-17 起为 FSRS-6,原 SM-2）"的完整学习闭环。本设计文档规划 **iOS 原生 APP**，同样开源，分三阶段推进：

| 阶段 | 目标 | 商业化 |
|---|---|---|
| **一期** | 纯本地核心体验：文章阅读 + AI 逐句翻译/精讲 + 生词收藏，BYOK（用户自带 API Key） | 无，完全免费 |
| **二期** | 账号体系 + 跨端同步（生词/SRS、文章、阅读进度），自建后端 | 为订阅铺路 |
| **三期** | 会员订阅（StoreKit 2）：云同步、托管 AI 额度、精选词包 | 正式商业化 |

### 设计原则

1. **跨端语义对齐**：句子切分算法、AI 输出 schema、JSON 解析容错逻辑与 Rust 实现对齐（本文引用具体源码位置）；通过共享 fixtures 和版本号发现漂移，而不是依赖源码行号或要求两个实现永久逐字相同。
2. **iOS 原生体验**：SwiftUI 原生开发；触屏交互（底部弹层代替桌面侧栏）、系统分享导入、AVSpeechSynthesizer 朗读（桌面版无 TTS，属 iOS 增强项）。
3. **开源友好 + 商业可分离**：核心全部开源；三期商业能力通过协议注入，开源仓库内只有 no-op 实现（open-core 模式）。

### 已确认的决策

- 技术栈：**SwiftUI 原生**（iOS only，不做跨平台框架）
- 一期范围：**文章阅读 + AI 逐句翻译/精讲**（含最小导入与生词收藏；不含视频/ASR/EPUB/PDF/KTV/思维导图/聊天助手）
- AI 模式：**BYOK**，Provider 列表与桌面版一致，Key 存 iOS Keychain

### 评审后新增的硬约束

1. **一期只承诺本地闭环，不承诺“预埋字段即可零迁移同步”**。同步协议、冲突解决和服务端版本号必须在二期开工前另写 RFC；一期只保证实体使用客户端生成 UUID、保留 `created_at` / `updated_at`。
2. **Share Extension 不直接写业务主库**。扩展只向 App Group 的 inbox 写入小型导入任务，主 App 消费任务后再以单事务写入主库，避免扩展被系统终止、主 App 与扩展版本不一致时发生迁移竞争或半成品文章。
3. **结构化 AI 请求一期全部使用非流式完成接口**。精讲与批翻都要完整 JSON 才能提交；“全文精讲”的进度来自已完成句数，而不是 token 流。SSE 仅作为普通文本能力保留，不进入一期关键路径。
4. **文章正文发送给第三方 AI 前必须明确告知并取得一次性授权**，设置页持续展示当前 Provider、其隐私政策入口和“内容会离开设备”的状态；日志不得记录正文、Prompt、API Key 或完整响应。
5. **一期完成定义以验收指标为准**：离线阅读/收藏可用；导入和数据库写入具备原子性；AI 请求可取消、可重试且不重复写入；1,000 句文章在基准设备上可正常滚动；VoiceOver、Dynamic Type、深浅色通过走查。

---

## 2. 工程结构

### 2.1 仓库位置与模块划分

在 monorepo 根新增顶层目录 `openkoto-ios/`，与 `textlingo-desktop/` 平级。采用 **"薄 App 壳 + 本地 SwiftPM 多模块包"** 结构——Xcode 工程文件只承载 App target 与 Share Extension，几乎所有代码放在本地 Swift Package 中，最大化减少 `.xcodeproj` 合并冲突（开源协作的主要痛点）：

```
openkoto-ios/
├── OpenKoto.xcodeproj
├── App/                          # App 壳（@main、根导航、依赖装配）
│   ├── OpenKotoApp.swift
│   ├── Assets.xcassets           # AppIcon 复用 textlingo-desktop/src-tauri/icons/ios/
│   └── PrivacyInfo.xcprivacy
├── ShareExtension/               # 分享导入扩展（只写 App Group inbox，不访问主库）
├── Packages/
│   └── OpenKotoKit/              # 单一本地 Package、多个 library target
│       ├── Package.swift
│       ├── Sources/
│       │   ├── OKModels/         # 纯值类型领域模型（零依赖，主 App 与扩展共享）
│       │   ├── OKPersistence/    # GRDB 数据库、迁移、DAO
│       │   ├── OKAIClient/       # 多 Provider LLM 客户端、SSE、Prompt、JSON 修复
│       │   ├── OKSegmentation/   # 句子切分（移植 Rust 算法）
│       │   ├── OKDesignSystem/   # 主题、颜色 token、字体、通用组件
│       │   ├── OKLocalization/   # en/zh/ja 字符串资源（String Catalog）
│       │   └── OKFeatures/       # Library / Reader / Import / Settings / Vocabulary
│       └── Tests/                # 切分金样本、FSRS 金样本、JSON 修复等单测
└── docs/
```

选择单 Package 多 target 而非多 Package：只需维护一个 `Package.swift`，同时保留强制分层（如 `OKAIClient` 不允许 import `OKFeatures`）。非 UI 逻辑可在 CI 上直接 `swift test`（无需模拟器）。

### 2.2 系统版本与工具链

- **最低版本 iOS 17.0**。这是维护成本与首期用户范围的产品决策，不使用未经项目分析验证的“95%+ 覆盖率”作为依据。真正要求 iOS 17 的主要是 Observation（`@Observable`）与 `ContentUnavailableView`；`URLSession.bytes`、SwiftUI `Layout` 和 `presentationDetents` 本身并非都从 iOS 17 才可用。
- 不以 iOS 18/26 为基线：无硬依赖新 API；用 Xcode 26 SDK 编译自动获得新系统外观，个别增强用 `if #available` 渐进采用。
- Swift 6（严格并发模式），Xcode 26。
- CI 固定 Xcode 的**完整版本号**，并提交 `Package.resolved`；升级 Xcode/Swift 或 GRDB 单独提 PR，避免编译器升级与功能开发耦合。

---

## 3. 持久化层（OKPersistence）

### 3.1 选型：GRDB.swift + SQLite

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| JSON 文件（对齐桌面 `storage.rs`） | 迁移逻辑最简单 | 列表/搜索/SRS 到期查询需全量加载 | 否 |
| SwiftData | 声明式、@Query 集成好 | 自定义后端同步需绕过 PersistentIdentifier；schema 演进控制弱 | 否 |
| Core Data | 成熟 | 样板重，与 Swift 并发交互差 | 否 |
| **GRDB.swift** | 显式 schema/迁移、`ValueObservation` 驱动 SwiftUI、同步字段可控、纯值类型 Record | 需手写 schema；FTS tokenizer 能力需按系统 SQLite 实测 | **选定** |

决定性理由是 schema 演进和查询可控；二期的自建同步也是加分项，但不能由桌面版存在 `backend_url`/`auth_token` 两个字段推导出同步方案已经成立。同步终局仍倾向**自建后端**而非 CloudKit，以覆盖桌面/Web/未来 Android。

### 3.2 数据模型（镜像 `src-tauri/src/types.rs`）

嵌套结构（`SegmentExplanation` 及其词汇/语法数组）**按 JSON 列存储**，与桌面版文档式存储语义一致，避免过度范式化：

```swift
// OKModels —— 领域模型；跨端传输另建 snake_case WireDTO
struct Article: Codable, Identifiable {
    var id: UUID              // WireDTO 编码为 UUID string
    var title: String
    var content: String
    var sourceType: SourceType?   // 一期仅 article | web
    var sourceURL: String?
    var createdAt: Date       // WireDTO 编码为 RFC3339
}

struct ArticleSegment: Codable, Identifiable {
    var id: UUID
    var articleId: UUID
    var order: Int
    var text: String
    var readingText: String?               // 注音/furigana 行
    var translation: String?
    var explanation: SegmentExplanation?   // 存 explanation_json 列
    var isNewParagraph: Bool
    var createdAt: Date
}

struct SegmentExplanation: Codable {
    var translation: String
    var explanation: String
    var readingText: String?
    var vocabulary: [VocabularyItem]       // word/meaning/usage/example/reading
    var grammarPoints: [GrammarPoint]      // point/explanation/example
    var culturalContext: String?
    var difficultyLevel: String?           // beginner|intermediate|advanced
    var learningTips: String?
}

struct FavoriteVocabulary: Codable, Identifiable {  // 含完整 FSRS 字段(见 SRS 规范 §1.1)
    var id: UUID
    var word, meaning, usage: String
    var explanation, example, reading: String?
    var sourceArticleId: UUID?
    var sourceArticleTitle: String?
    var packIds: [UUID]                    // JSON 列；一期只有默认词包
    var srsState: SRSState                 // new | learning | review
    var easeFactor: Double                 // 默认 2.5，下限 1.3
    var repetitions, intervalDays: Int
    var dueDate: DateComponents            // WireDTO/DB 为 "YYYY-MM-DD" 本地日期
    var lastReviewedAt: Date?
    var reviewCount: Int
    var createdAt: Date
}
```

为避免“对齐桌面字段”演变成 stringly-typed 业务代码，Swift 领域层使用 `enum ProviderID`、`enum SourceType`、`enum SRSState`、`Date` / `DateComponents`；仅 `WireDTO` 和 SQLite 编解码层使用桌面的字符串格式。未知枚举值必须可保留或显式报错，不能静默映射成默认值。

SQLite 表：`article`、`segment`（`explanation_json TEXT`）、`favorite_vocabulary`、`word_pack`。关键约束如下：

- `segment.article_id` 外键关联 `article.id`，删除文章级联删除 segment；`segment(article_id, order_index)` 唯一。
- `favorite_vocabulary.source_article_id` 删除时置空，标题快照保留；收藏去重规则一期确定为 `normalized_word + source_article_id`，UI 再允许用户重复收藏到不同词包。
- `translated` 不作为事实来源：列表徽标和进度由 segment 聚合得到；如为性能保留缓存列，必须在同一事务内更新并有一致性测试。
- 全部写操作通过单一 repository 入口和 GRDB `DatabaseWriter` 的事务能力协调；建库迁移只由主 App 执行。开启 foreign keys，并为文章导入、重切分、精讲回填写事务测试。
- 一期保留 `created_at`、`updated_at`；不提前加入 `dirty` / `deleted_at` 并声称二期零迁移。同步至少还需要服务端 revision、设备/操作标识、墓碑保留策略与服务器时间语义，待同步 RFC 确认后迁移。
- `explanation_json` 同时记录 `target_language`、`provider_id`、`model_id`、`prompt_version`、`generated_at` 和 `source_text_hash`；正文、目标语言或 Prompt 改变时可判定结果已过期。

搜索一期先使用转义后的 `LIKE`（标题 + 正文）并设置结果上限；FTS5 只有在真机验证 tokenizer 对中/日文与子串搜索符合预期后启用。不能只写“FTS5”却不定义 tokenizer、建表/触发器和迁移回填策略。

### 3.3 配置与密钥

- **AppConfig**：不入库。`ModelConfig` 列表（**剥离 api_key 字段**）、`activeModelId`、`targetLanguage`、`interfaceLanguage`、`batchTranslationConcurrency`（默认 3）、主题选择等存 **UserDefaults**（Codable JSON）。
- **API Key 只存 Keychain**（详见 §4.5），任何导出/日志统一脱敏。

### 3.4 SRS 调度算法（FSRS-6,已实现）

> 2026-07-17 修订:双端统一从 SM-2 升级为 **FSRS-6**,权威规范见
> `docs/specs/vocabulary-srs-spec.md`(数据模型、公式求值顺序、事件日志、统计口径、同步预留)。

- 引擎为纯函数 `OKSRS/FSRS.swift`,1:1 镜像桌面 `src-tauri/src/fsrs.rs`(参考实现 ts-fsrs 5.4.1 长期模式);
- 评分映射:不认识→Again(1) / 模糊→Hard(2) / 认识→Good(3),Easy(4) 引擎支持、UI 暂不使用;
- 双端共享黄金用例 `docs/specs/fixtures/fsrs_golden_v1.json`(iOS 侧逐字副本由 Rust 测试守护字节一致);
- 每次复习追加一条**不可变复习事件**(`review_log` 表 / 桌面月度 JSONL),是二期同步的重放单元;
- 复习卡片 UI(`ReviewSessionView`)已随 FSRS 落地一并提前实现(原计划 1.5 期)。

---

## 4. AI 客户端层（OKAIClient）

### 4.1 Provider 抽象

桌面版 `ai_service.rs` 实际只有三种协议形态：**OpenAI-compatible**（openai / deepseek / openrouter / siliconflow / 302ai / moonshot / kimi / ollama / lmstudio / openai-compatible）、**Anthropic Messages**、**Google Gemini generateContent**。iOS 同构：

```swift
struct ModelConfig: Codable, Identifiable {   // 镜像 types.rs 的 ModelConfig，api_key 剥离
    var id: UUID
    var name: String
    var apiProvider: ProviderID
    var model: String
    var baseURL: URL?
    var isDefault: Bool
}

protocol ChatTransport: Sendable {
    func complete(_ req: ChatRequest) async throws -> String
    func stream(_ req: ChatRequest) async throws -> AsyncThrowingStream<ChatDelta, Error>
}
// 三个实现：OpenAICompatibleTransport / AnthropicTransport / GeminiTransport
```

`ChatRequest` 必须携带用途（test / translate / explain）、超时、最大输出 token 与 request ID；错误统一映射为 `AIClientError`（网络不可达、401/403、429、服务端 5xx、响应格式错误、取消、策略/内容拦截）。只有安全、幂等的请求允许指数退避重试；401/403、解析错误和用户取消不自动重试。HTTP 状态与 Provider 错误体先完成校验，再向上层暴露 stream。

需逐条对齐的桌面行为（均出自 `src-tauri/src/ai_service.rs`）：

- **URL 解析**（`get_api_url`，L62）：自定义 baseURL 自动补 `/chat/completions`；Gemini URL 为 `.../v1beta/models/{model}:generateContent` 并 strip `models/` 前缀。
- **认证头**：OpenAI 系 `Authorization: Bearer`；Anthropic `x-api-key` + `anthropic-version: 2023-06-01`（L130）；Google `X-goog-api-key`（L233）。
- **Moonshot 特例**：temperature 强制 1.0；k2.5 模型附加 `thinking: {type: enabled}`。
- **温度参数**：翻译/精讲 0.3，分析 0.5，聊天默认 0.7。

### 4.2 流式（SSE）

`URLSession.bytes(for:)` + `AsyncLineSequence`：按 SSE event 边界处理多行 `data:`、空行、CRLF、注释/keep-alive、`[DONE]` 和非 2xx 错误，不把“逐行 JSON”误当成完整 SSE 规范。桌面版对 Google/Anthropic 不做流式而是整包返回；一期的**结构化任务（逐句精讲、批量快翻）对全部 Provider 都走 `complete`**，只有未来普通文本 UI 才消费 `stream`。这样取消、JSON 修复和数据库提交边界都更明确。

### 4.3 Prompt 移植（语义对齐 + 版本化）

- **逐句精讲**：`segment_translate_explain`（`ai_service.rs:749`）以语义和输出 schema 对齐为准——含目标语言名映射、完整 JSON schema（translation / explanation / vocabulary / grammar_points / cultural_context / difficulty_level / learning_tips）、user message `"Analyze this: {text}"`。放入 `PromptLibrary.swift` 多行字符串常量，并给 Prompt 分配稳定 `promptVersion`。不要依赖易漂移的源码行号或承诺永久“逐字一致”；Swift/Rust 共享 golden fixtures 来发现变更。
- **批量快翻**：`batch_translate`（L298）：编号 `[id] text` 列表 + 要求返回 `[{"id","translation"}]` JSON 数组，每批 ≤30 条（`commands.rs:1552` `BATCH_SIZE = 30`）。
- **单句翻译** system prompt（L263 附近）。
- `prompt_features`（聊天快捷指令模板）属聊天助手功能，一期不移植，数据结构预留。

### 4.4 JSON 提取与修复（可用性关键，必须移植）

移植为 `LLMJSONExtractor`：

1. **extractJSON**（`ai_service.rs:948`）：优先 ```` ```json ```` 代码块 → 通用代码块 → 花括号配平扫描 → 兜底 trim。
2. **repairJSON**（L1006）：字符串内未转义换行→`\n`、智能引号（“”）归一、按"闭引号后必须跟 `,:}]`"启发式转义字符串内部引号、去尾逗号。
3. 解析 `SegmentExplanation` 失败 → 修复 → 再失败抛出带 request ID 的脱敏错误。**原始模型响应只允许在用户主动开启的临时诊断导出中出现**，不能进入常规日志或崩溃上报。

### 4.5 Keychain

`KeychainStore`：`kSecClassGenericPassword`，service = `app.openkoto.ios.apikey`，account = `ModelConfig.id`，默认 **`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`**（不进 iCloud Keychain 同步，也不需要锁屏后台访问）。删除模型配置时必须同步删除 Keychain 项；更新 ID 不得遗留孤儿 Key；SecureField 不回显完整 Key，只显示“已配置”并允许覆盖/清除。

自定义 Base URL 默认只接受 HTTPS。若用户选择 Ollama/LM Studio 等局域网 HTTP 服务，单独展示安全警告并补齐 Local Network/ATS 配置与真机测试；不要把本地 Provider 与公网 `openai-compatible` 当成完全相同的网络场景。

### 4.6 并发调度

"全文精讲"由 `actor BatchJobCoordinator` 管理有界并发，并发数 = `batchTranslationConcurrency`（默认 3，对齐桌面）；每段成功后以短事务落库，任务状态记录 completed/failed/pending，支持失败项重试与断点续跑。取消必须贯穿 `URLSessionTask`，并在写库前再次校验 job ID、segment ID、`source_text_hash` 和目标语言，防止用户切换文章、重切分或修改设置后旧请求覆盖新数据。批翻按 30 句组包，但要同时设置字符/token 上限，超限动态缩小批次。

---

## 5. 句子切分（OKSegmentation）

桌面版实际行为（`commands.rs:64-200`）：

1. 按 `\n` 切段落，trim 后丢弃空行；
2. 段内按句末符 `。？！. ? !` 切句，**保留标点**；
3. 英文句点缩写启发式（后跟字母、Mr/Dr 等词表、单大写字母）；
4. 句末符后紧跟的闭引号/右括号（`" ' ' ) ）`）归并入句；
5. 段落首句 `is_new_paragraph = true`；
6. `resegment_article`（L1350）用同一函数整篇重切（重切生成全新 segment id，已有翻译/精讲作废）。

**选定方案：将该算法 1:1 移植为 Swift `SentenceSegmenter`，不用 NLTokenizer。**

理由：二期跨端同步后，同一篇文章在 iOS/桌面/Web 重切必须产出相同句子边界，否则翻译/精讲会错位；NLTokenizer 的边界规则（省略号、缩写、中日文混排）与桌面算法不一致且不可控。该算法仅 ~130 行，移植成本低；用同一组中/日/英混合 fixture 做 Swift ↔ Rust 金样本对齐单测。NLTokenizer 可作为 `SegmentationStrategy` 协议的第二实现留作实验（如无标点歌词），默认不启用。

---

## 6. 一期功能规格（按屏幕）

### 6.1 信息架构

TabView 三个 tab：**书库（Library）**、**生词本（Vocabulary）**、**设置（Settings）**；阅读器从书库经 `NavigationStack` push 进入。

一期范围裁剪（最小切）：

- ✅ 导入：粘贴文本、`.txt`/`.md` 文件、Share Extension（接收纯文本与 URL）
- ✅ 生词收藏 + 生词本列表（FSRS 字段落库,见 §3.4 / SRS 规范）
- ✅ SRS 复习卡片 UI（`ReviewSessionView`,2026-07-17 随 FSRS 统一改造从 1.5 期提前落地）
- ❌ URL readability 正文抽取（1.5 期）、聊天助手、视频/书籍/ASR/KTV/思维导图（二期+）

### 6.2 书库（Library）

- 文章卡片列表：标题、创建时间、字数、翻译状态徽标、精讲进度（均由已完成 segment 数/总数 SQL 聚合，不读取可能漂移的 `article.translated`）。
- 右上角 `+` 打开导入 sheet；左滑删除（确认弹窗）、改名。
- 空状态 `ContentUnavailableView` 引导导入；首启无 ModelConfig 时展示配置引导（对标桌面 OnboardingDialog 精简版）。
- 搜索：一期使用有结果上限的标题 + 正文查询；FTS5 tokenizer 经中/日文真机验证后再替换，见 §3.2。

### 6.3 导入（Import Sheet）

- **粘贴文本**：标题（可自动取首行）+ 多行正文；保存时调 `SentenceSegmenter` 生成 segments（`sourceType = "article"`）。
- **文件**：`fileImporter`（UTType.plainText / .text），在 security-scoped resource 有效期内复制/读取；支持 UTF-8（含 BOM），无法解码时给出明确错误，不静默产生乱码。限制单文件大小与最大句数，标题/正文校验后在一个事务中写 article + segments。
- **Share Extension**：接收 `public.plain-text` / `public.url`，在 App Group 中原子写入版本化 `ImportEnvelope`（id/type/payload/sourceApp/createdAt/schemaVersion），随后调用 `completeRequest`。主 App 在启动/回前台消费 inbox，去重成功后才删除任务。扩展**不加载 GRDB、不跑迁移、不持有 API Key、不调用 AI**。
- **URL 分享的一期语义**：只打开“待导入”编辑页，预填 URL 与分享方提供的 title/text；若没有正文，明确提示粘贴内容，**不创建空占位文章**。网页正文抽取仍属 1.5 期。

### 6.4 阅读器（Reader）—— 核心屏幕

交互基准来自桌面版 `src/components/features/ArticleReader.tsx`：句子为内联 chip（选中态 primary 填充 + ring，有精讲绿色边框，有翻译黄色边框），点击无精讲的句子自动触发生成，视图模式 original/bilingual/translation，字号 12–32。

**正文区**

- 自定义 `FlowLayout`（SwiftUI `Layout` 协议）逐段排布 `SentenceChip`；`isNewParagraph == true` 另起段落。
- `SentenceChip` 状态样式（色语义对齐桌面）：默认透明边框 / 已翻译黄 30% 边框 / 已精讲绿 30% 边框 / 选中 primary 20% 填充 + primary 边框；圆角 8pt。
- 视图模式（顶部工具栏 segmented control）：**原文** = 只显示 chip；**对照** = 句上方注音行（等宽字体）+ 句下方灰底圆角框译文；**译文** = 只显示译文。
- 字号 stepper 12–32pt（UserDefaults 持久化）；阅读进度（滚动位置 segment order）持久化，重进恢复。

**点按交互（核心流程）**

1. 点句 → chip 选中 → 底部弹出 `ExplanationSheet`（`presentationDetents([.medium, .large])` + `presentationBackgroundInteraction(.enabled(upThrough: .medium))`，半屏时正文仍可滚动换句，替代桌面右侧栏）。切换句子时 sheet 复用同一 presentation 并绑定 segment ID，避免快速点按产生多 sheet 或旧请求串位。
2. 该句无 explanation 时：sheet 内立即显示原句 + shimmer 加载态，同时发起精讲请求；完成即写库（对齐桌面 `update_article_segment` 语义：同时回填 explanation、readingText、translation）。
3. Sheet 分区（对齐桌面讲解面板）：**翻译**（muted 卡片）→ **讲解**（受限 Markdown；外部链接须二次确认）→ **词汇**（amber 卡片，星标收藏 → 写入 `favorite_vocabulary`，带来源文章快照）→ **语法**（紫色左边线卡片）→ **文化背景 / 难度 / 学习建议**（折叠）。模型输出始终视为不可信文本，不解释 HTML，也不执行自定义 URL scheme。
4. Sheet 底部工具条：上一句 / 下一句、**朗读**（AVSpeechSynthesizer，`NLLanguageRecognizer` 检测语种选 voice；iOS 增强项）、复制。

**批量操作（工具栏菜单）**

- **快速翻译**：批量翻译未翻译句（30 句/批），进度条 + 可取消。
- **全文精讲**：并发 3 逐句精讲，逐句落库、chip 实时变绿。
- **重新切分**：等价 `resegment_article`，警告将清空已有翻译/精讲（与桌面行为一致）。

**可访问性与性能约束**：每个句子暴露完整 VoiceOver label/value/hint，不能只依赖黄/绿边框表达状态；44pt 最小点击区域；阅读字号采用可缩放基准值而不是绕过 Dynamic Type。正文按段落 `LazyVStack` 虚拟化，段内 FlowLayout；为极长单段设置可控分块策略。译文模式遇到未翻译句时显示原文占位并提供生成操作，不能出现“正文消失”。

**注音/Furigana**：一期与桌面对齐——readingText 显示为句间独立一行（等宽字体）。真 ruby（CoreText `kCTRubyAnnotationAttributeName`，SwiftUI Text 不支持，需 UIViewRepresentable/自绘）列为 1.5 期增强，不阻塞主线。

### 6.5 生词本（Vocabulary）

> 2026-07-17 修订:随 FSRS 统一改造,以下能力已实现(超出原一期最小切):

- 列表:word / reading / meaning,createdAt 倒序;点击进入编辑表单;左滑删除,右滑"已掌握/恢复"。
- 顶部统计:总数、今日到期数、连续打卡、状态分布(未学/学习中/复习中/已掌握)、今日进度。
- 搜索(`.searchable`,词形/释义/读音内存过滤)、工具栏 `+` 手动加词(按 normalized_word 全局去重)。
- 每行保持率色点 + 保持率百分比(FSRS retrievability,分档规则见规范 §5)。
- 底部"开始复习"进入 `ReviewSessionView` 闪卡(三档评分,顶部今日进度条)。
- 词包(合集)管理 UI(2026-07-18 补齐):顶部合集 chips 过滤(全部/各合集,驱动列表、到期数、统计与复习队列)、`PackManagerSheet` 新建/重命名/删除(系统"未分组"锁定;删包后孤儿词归"未分组",镜像桌面 `delete_word_pack_cmd`)、加词/编辑表单多选合集归属。okpack 导入导出 iOS 侧留后续。

### 6.6 设置（Settings）

- **AI 模型**：ModelConfig 列表（CRUD + 设默认）；表单 = 名称 / Provider 选择器 / 模型名 / API Key（SecureField → Keychain）/ 自定义 Base URL（openai-compatible 必填）；"测试连接"按钮（发一条最小 chat 请求）。Provider 能力表集中定义默认 URL、认证方式、是否允许空 Key、是否支持 stream、模型特例和隐私政策 URL，UI 与 transport 共用，避免两套 switch 漂移。
- **学习**：目标语言（zh-CN / zh-TW / en / ja / ko / es / fr / de / ru / ar，对齐 `ai_service.rs` 语言名映射表）、并发数。
- **外观**：主题（California / Tokyo / Seoul）× 外观（跟随系统 / 浅色 / 深色）。
- **隐私与数据**：当前 AI Provider、发送内容范围、第三方 AI 授权状态、隐私政策、清除本地文章/生词/API Key、导出诊断信息（默认脱敏）。首次 AI 请求前展示授权，用户可在此撤回。
- **通用**：界面语言（en/zh/ja，String Catalog）、关于（版本、开源许可、GitHub 链接）。

---

## 7. 设计系统（OKDesignSystem）

### 7.1 颜色

桌面主题以 OKLCH 定义（`src/styles/themes/california.css` / `tokyo.css` / `seoul.css`，每主题 light + dark 两组 ~30 个语义 token）。默认 **California**：暖米白背景（≈#FDFCFA 浅 / #2A2622 深）+ 焦橙 primary（≈#B45F1E 浅 / #F0812E 深）、紧凑圆角；Tokyo 靛蓝紫、Seoul 紫罗兰。

**选定方案：构建期转换，运行时纯 Swift 常量。** 一次性脚本把三个 CSS 的 OKLCH 值转成 **Display P3**，生成 `Palette+California.swift` 等文件。不用 Asset Catalog——需支持"3 主题 × 2 外观"二维切换，Asset Catalog 只原生支持 light/dark 一维。

```swift
struct ThemeTokens {          // 语义 token 与 CSS 变量一一对应
    let background, foreground, card, cardForeground,
        primary, primaryForeground, secondary, muted, mutedForeground,
        accent, destructive, border, input, ring: Color
}
enum ThemeID: String, CaseIterable { case california, tokyo, seoul }

@Observable final class ThemeManager {
    var themeID: ThemeID
    var appearance: AppearanceMode        // system / light / dark
    func tokens(for colorScheme: ColorScheme) -> ThemeTokens
}
// Environment 注入：@Environment(\.themeTokens) var theme
```

- 圆角 token：California `--radius: 0.3rem` ≈ 5pt（紧凑风格）；卡片 8pt、sheet 12pt。
- 语义扩展色：`explained`（green）、`translatedHint`（yellow/amber）、`grammarAccent`（purple）——对应 chip 与卡片状态色。

### 7.2 字体

- UI：系统 SF Pro。**不引入桌面的 Oxanium / Fira Code**——它们无 CJK 字形，桌面上 CJK 实际也回退到系统字体。
- 正文阅读：默认系统字体 + 可选衬线（`.fontDesign(.serif)` = New York；日文自动回退 Hiragino Mincho 系）。
- 注音行：`.monospaced`，对齐桌面。
- 全部走 Dynamic Type 相对字号；阅读器字号 stepper 独立覆盖。

### 7.3 组件清单

`SentenceChip`、`SegmentFlowLayout`、`ExplanationSheet`、`TranslationBox`、`VocabCard`（amber + 星标）、`GrammarCard`（紫左边线）、`ReaderToolbar`、`ViewModePicker`、`FontSizeStepper`、`ProgressBanner`（批量任务）、`ProviderPicker`、`ModelConfigForm`、`ThemedCard`、`EmptyState`、`ErrorBanner`。

---

## 8. 二/三期架构草案（仅设计，不在一期实现）

### 8.1 账号与同步（二期）

> 2026-07-17 注:FSRS 统一改造已把同步地基落地——双端不可变复习事件日志(iOS `review_log` 表 /
> 桌面月度 JSONL)、iOS `word_pack_membership` 关系表(取代 `pack_ids` JSON)、`SyncEngine`
> 接口 + `NoopSyncEngine`(Swift 已实现)。复习同步即按下述"同步 review event 重放重算"路线,
> 详见 `docs/specs/vocabulary-srs-spec.md` §8;协议细节仍待二期 Sync RFC。

- **认证**：候选为 Sign in with Apple + 邮箱验证码；若引入第三方/社交登录，按届时有效的 App Review 4.8 要求提供等价隐私登录选项。后端签发短期 access token，refresh token 存 Keychain，并定义撤销、登出和账号删除流程。
- **同步策略结论：自建后端，否定 CloudKit。** 依据：桌面 `AppConfig` 已预留 `backend_url` / `auth_token`，openkoto.com Web 版已存在，Android 在路线图——CloudKit 无法覆盖非 Apple 端。
- **同步协议仅为候选**：实体级增量——`GET /sync/pull?cursor=<opaque>` + `POST /sync/push`。cursor 必须由服务端生成且不解释为客户端时间；push 要有幂等 operation ID，服务端返回每个实体的新 revision/冲突结果。
- **冲突原则**：不能直接用客户端 `updated_at` 做 LWW（设备时钟可漂移）。普通字段以 server revision + 明确冲突策略处理；文章重切分作为带 `segmentation_revision` 的整体操作，不与旧 segment 逐行混合。SRS 不只比较 `last_reviewed_at`，更稳妥的方案是同步不可变 review event，再由事件重算状态；若仍同步快照，必须定义同日多设备复习的合并规则。
- **墓碑与体积**：定义墓碑保留期、首次全量同步、分页上限、压缩、附件/大正文限制、登出时本地数据归属、账号删除和恢复流程。`pack_ids` JSON 对多端并发编辑不友好，二期迁移为关联表或集合操作。
- 二期开工门槛：先完成独立 Sync RFC、协议契约测试和离线/双端/时钟漂移/重复 push/删除后离线编辑测试；一期不承诺零迁移。
- 同步范围优先级：生词/SRS 状态 → 文章 + segments（体积大，需分页/压缩）→ 阅读进度。

### 8.2 订阅（三期）

- StoreKit 2（`Product` / `Transaction.currentEntitlements`），后端用 App Store Server API 校验并下发统一 entitlement（跨端共享会员态）。
- 权益切分（**BYOK 本地功能永久免费**，既保证开源可用性也降低审核风险）：会员 = 跨端云同步 + 托管 AI 额度（平台代付 key，免配置）+ 精选词包/内容。

### 8.3 开源仓库的商业分离（open-core）

```swift
public protocol EntitlementProviding { var isPro: Bool { get } }
public protocol SyncEngine { func pull() async throws; func push() async throws }
```

开源仓库内提供 `NoopEntitlements` / `NoopSyncEngine` 默认实现，App 壳在装配处注入；商业实现可放独立闭源 SwiftPM 仓库（`OpenKotoCommerce`）。但“通过 xcconfig flag 条件引入私有 Package”需要先做可复现 PoC；SwiftPM 依赖解析发生在编译条件之前。更稳妥的方案是官方发行工程/私有聚合 Package 与开源工程分离，并在 CI 分别验证。**开源构建必须在无私有凭据、无私有依赖时 100% 可编译。**

---

## 9. 里程碑（一期，约 8 工程周）

下表是净开发量估算，不等于 8 个自然周，也不含 Apple 审核等待、证书/App Group 配置、设计素材返工和 Provider API 变更。单人排期建议另加 20%–30% 风险缓冲；多人并行仍受 M2→M3→M4 关键路径限制。

| 里程碑 | 范围 | 粗估 |
|---|---|---|
| **M0 脚手架** | `openkoto-ios/` 目录、Xcode 工程 + OpenKotoKit 包骨架、CI（swift test + build）、AppIcon 迁移、String Catalog en/zh/ja | 0.5 周 |
| **M1 设计系统** | OKLCH→P3 转换脚本、ThemeTokens × 3 主题 × 明暗、基础组件、主题预览 Playground | 1 周 |
| **M2 模型 + 持久化** | OKModels/WireDTO、GRDB schema + 迁移 + 约束/事务测试、`SentenceSegmenter` 移植 + 金样本单测、FSRS-6 移植 + 黄金用例单测（`docs/specs/vocabulary-srs-spec.md`） | 1 周 |
| **M3 AI 客户端** | 三 Transport、非流式结构化请求、可选 SSE、错误分类/取消/退避、PromptLibrary、LLMJSONExtractor、Keychain、URLProtocol 契约测试 | 1.5 周 |
| **M4 阅读器** | FlowLayout + SentenceChip、三视图模式、ExplanationSheet、单句精讲闭环、快翻/全文精讲批量任务、TTS、生词收藏 | 2 周 |
| **M5 导入 + 设置 + 生词本** | 粘贴/文件导入、Share Extension inbox、第三方 AI 授权、设置全屏、生词本列表 | 1 周 |
| **M6 打磨 + TestFlight** | 深浅色/动态字体/VoiceOver、隐私政策与 App Privacy、错误态统一、长文性能、迁移恢复演练、TestFlight 分发 | 1 周 |

关键依赖链：M2（模型）→ M3（AI）→ M4（阅读器）；M1 可与 M2/M3 并行。

### 9.1 测试与验收矩阵

| 层级 | 必测内容 | 一期门槛 |
|---|---|---|
| 纯单测 | 切分 golden fixtures、FSRS 黄金用例、日期/时区、Prompt 版本、JSON 提取/修复 | Linux/macOS `swift test` 稳定通过 |
| 数据库 | 首建与逐版迁移、外键/唯一约束、导入与重切事务回滚、损坏库的只读备份与恢复提示 | 每个历史 schema fixture 均可迁到最新 |
| AI 契约 | 三 Provider 成功响应、401/429/5xx、超时、取消、坏 JSON、超长响应、SSE 多行事件 | 使用 `URLProtocol` stub，不依赖真实付费 API |
| UI/可访问性 | 导入→阅读→精讲→收藏主路径；VoiceOver、最大 Dynamic Type、深浅色、Reduce Motion | 核心路径 UI test + 人工走查清单 |
| 性能 | 1,000 句/约 10 万字文章的打开、滚动、搜索、批量写入；内存警告后恢复 | 基准设备无明显长时间主线程卡顿，指标在 M0 用 `XCTMetric` 固化 |
| 真机集成 | Share Extension、Keychain、App Group、Local Network、前后台取消与断点续跑 | 至少一台最低系统设备 + 当前系统设备 |

TestFlight 前的发布清单还包括：无 Key 示例路径、审核账号/操作说明、第三方 Provider 隐私披露、隐私政策 URL、依赖许可证清单、崩溃日志脱敏验证、删除数据与撤回授权验证。

---

## 10. 风险与开放问题

1. **App Review / BYOK**：不以其他 App 的过审作为保证，也不武断写成“生成式 AI 必须 17+”。实际动作是：(a) 内置免 Key 示例文章与预置精讲，让审核可验证核心 UI；如审核需验证联网路径，在 Review Notes 提供可用方式；(b) 按目标 storefront 的最新 3.1.1 规则审查外部购买链接，不能用一条全球化结论代替；(c) 如模型可能产生不适宜内容，提供举报/重试/删除与必要的内容安全策略，并在 App Store Connect 如实填写年龄分级。
2. **LLM 结构化输出不稳定**：小模型常产出坏 JSON。缓解：完整移植桌面修复管线（§4.4），失败提供重试和用户可理解的错误；原始响应仅进入用户主动导出的临时脱敏诊断包。
3. **长文性能**：数百 segment 的 FlowLayout 一次性布局会卡。缓解：按段落分块 + `LazyVStack`，段内才用 FlowLayout。
4. **前台限制**：批量精讲退后台会被挂起。`beginBackgroundTask` 只提供有限完成窗口，并不是通用后台执行方案。缓解：逐句落库 + 断点续跑；进入后台时停止派发新请求，已发请求在 expiration handler 中取消并正确 end task，回前台由用户继续。
5. **许可证**：根 LICENSE 为 Apache 2.0 + Dify 式附加条款，其中"frontend"定义未覆盖 iOS 目录——建议随 iOS 目录落地时同步修订措辞（明确 iOS App 的 LOGO/版权条款适用性）。另注意 `pdf-sidecar/LICENSE`（pdf2zh 派生）可能有更强 copyleft，与 iOS 无关但开源前值得复查。
6. **隐私与第三方 AI**：文章可能含个人或机密信息。根据 Apple 当前审核要求，向第三方 AI 分享个人数据前要清晰披露并获得明确许可；仅有一份笼统隐私政策不够。缓解：首次发送前 Provider 级授权、设置页可撤回、请求前持续可见、零正文日志、提供本地删除。
7. **开放问题**：(a) 1.5 期是否引入可维护、许可证兼容的 readability 库；(b) Ollama/LM Studio 是一期正式支持还是仅高级实验项；(c) 最低系统的真实用户覆盖率需用现有产品数据或发布目标市场数据验证；(d) 官方闭源商业模块如何与开源工程解耦并保持可复现构建。

Apple 约束参考（实现/提审前需重新核对最新版本）：[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)、[Configuring App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups)、[Choosing Background Strategies](https://developer.apple.com/documentation/BackgroundTasks/choosing-background-strategies-for-your-app)。

---

## 附：关键参考文件

| 文件 | 用途 |
|---|---|
| `textlingo-desktop/src-tauri/src/ai_service.rs` | 精讲/批翻 Prompt 原文、三种 Provider 协议、SSE 解析、extract_json/repair_json（OKAIClient 移植蓝本） |
| `textlingo-desktop/src-tauri/src/commands.rs` | 句子切分算法（L64-200）、复习/队列/统计命令、批翻流程（L1552）、update_article_segment 落库语义 |
| `textlingo-desktop/src-tauri/src/fsrs.rs` | FSRS-6 调度引擎（Swift `OKSRS/FSRS.swift` 的镜像源,规范 `docs/specs/vocabulary-srs-spec.md`） |
| `textlingo-desktop/src-tauri/src/types.rs` | 全部数据模型字段与默认值 |
| `textlingo-desktop/src/components/features/ArticleReader.tsx` | 阅读器交互基准（chip 状态、自动精讲、视图模式、字号） |
| `textlingo-desktop/src/styles/themes/{california,tokyo,seoul}.css` | OKLCH 主题 token 源（OKDesignSystem 转换输入） |
| `textlingo-desktop/src-tauri/icons/ios/` | 现成 iOS AppIcon 资源 |
