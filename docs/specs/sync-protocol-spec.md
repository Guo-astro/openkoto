# OpenKoto 云同步协议规范 v1

> 状态：v1（P0 定稿）
> 适用：iOS / Mac Catalyst、桌面（Tauri）、网页、CLI，以及任何第三方客户端
> 参考实现：`packages/sync-client`（TypeScript）、`server/worker/src/sync`（服务端）
> 契约用例：`docs/specs/fixtures/sync/*.json`（所有客户端实现都必须通过）
> 设计背景：`docs/plans/2026-09-28-web-and-cloud-platform-design.md` §5

---

## 1. 术语

| 术语 | 含义 |
|---|---|
| 记录（record） | 同步的最小单位，由 `(type, id)` 唯一确定 |
| payload | 记录的完整业务 JSON；服务端不解析业务字段 |
| rev | 服务端为每次成功写入分配的单调递增整数（每个用户独立计数） |
| cursor | 客户端最后见过的 rev，形如 `c_<rev>`；**客户端必须把它当作不透明字符串** |
| HLC | 混合逻辑时钟，用于 LWW 排序（§3） |
| 墓碑（tombstone） | `deleted=true` 且 payload 为空的记录 |

## 2. 记录

### 2.1 线上格式

```json
{
  "type": "Vocabulary",
  "id": "3f0c2a4e-1d2b-4c5d-9e8f-0a1b2c3d4e5f",
  "rev": 1042,
  "hlc": "1727500000123-0001-a1b2c3d4",
  "deviceId": "d7f1…",
  "deleted": false,
  "payload": { "...": "..." }
}
```

- `id`：**小写**。UUID 主键一律转小写（iOS `UUID.uuidString` 是大写，发送前必须 `lowercased()`；接收时按小写比较）。
- 复合主键用下划线连接：`WordPackMembership` 的 id 为 `<vocabularyId>_<packId>`（与 iOS CloudKit 记录名规则一致）。
- `payload` 与 `blobKey` 二选一；payload 序列化后超过 **512 KB** 时必须改走 blob（§5.4）。
- 日期一律为 ISO 8601 UTC 字符串（`2026-09-28T10:00:00Z`，可带毫秒）。

### 2.2 记录类型与 payload

payload 字段沿用 iOS `OKModels` 的 `Codable` JSON（camelCase 属性名）。下表列出必填字段；未列出的可选字段客户端必须**原样保留**（读入后写回时不得丢弃未知字段）。

| type | id | payload 必填字段 | 合并策略 | 首批 |
|---|---|---|---|---|
| `Vocabulary` | 卡片 UUID | `word, meaning, srsState, stability, difficulty, dueDate, reviewCount, createdAt, updatedAt` | LWW；SRS 字段由事件重放覆盖（§6） | ✅ |
| `WordPack` | 词包 UUID | `name, tags, isSystem, createdAt, updatedAt` | LWW；`isSystem=true` 的系统包**不上传** | ✅ |
| `WordPackMembership` | `<vocabId>_<packId>` | `vocabularyId, packId` | 存在即成员；移出 = 墓碑 | ✅ |
| `ReviewEvent` | 事件 UUID | `vocabularyId, reviewedAt, dateLocal, grade, elapsedDays, previousState, schedulerVersion, desiredRetention, resultStability, resultDifficulty, resultIntervalDays, resultState` | **只追加**（§6）；可选 `voidsEventId` | ✅ |
| `Article` | 文章 UUID | `title, content, createdAt`；`sourceType ∈ {article, web, lyrics, …}` | LWW | ✅ |
| `Segment` | 句子 UUID | `articleId, order, text, isNewParagraph, createdAt`；可选 `segmentationRevision`（缺省 0） | 见 §4.3 | ✅ |
| `Book` | 书 UUID | `title, format, totalChars, defaultMode, originalOnly, createdAt`；可选 `fileSha256, fileSize` | LWW | ✅ |
| `BookChapter` | = 章节文章 UUID | `articleId, bookId, index, isSegmented, charCount` | LWW | ✅ |
| `BookMark` | 书签 UUID | `bookId, chapterIndex, kind, createdAt, updatedAt` | LWW | ✅ |
| `BookProgress` | = bookId | `bookId, chapterIndex, mode, updatedAt` | LWW（每本书一条） | ✅ |
| `LyricsMeta` | = articleId | `articleId`；可选 `artist, album, language, lrcOffsetMs, sourceFormat` | LWW | ✅ |
| `WordGloss` | 客户端定义 | — | LWW | 第二批 |
| `ReadingSession` | 会话 UUID | — | 只追加 | 第二批 |
| `Setting` | 设置键 | `value` | LWW；**禁止**同步任何 API Key | 第二批 |
| `Media` / `MediaPart` / `MediaProgress` | — | — | 保留类型名，本版不同步 | — |

服务端对未知 `type` 返回 `rejected: UNKNOWN_TYPE`；客户端收到自己不认识的 type 时**跳过但推进 cursor**。

### 2.3 合并顺序（mergeOrder）

同一批 pull 结果按以下顺序应用，保证外键先到：

`Book(0) → Media(1) → Article(2) → LyricsMeta(3) → BookChapter(4) → MediaPart(5) → Segment(6) → WordPack(7) → Vocabulary(8) → WordPackMembership(9) → BookMark(10) → BookProgress(11) → ReviewEvent(12) → 其余(99)`

外键尚未就绪的记录进入本地 pending 队列，下一轮重试（iOS `pending_cloud_payload` 即此机制）。墓碑命中是终局，不进入 pending。

## 3. HLC（混合逻辑时钟）

格式：`<wallMs 13 位十进制，左补 0>-<counter 4 位十进制>-<nodeId 8 位小写十六进制>`，按**字符串字典序**比较。

```
本地修改（send）:
  pt = now_ms()
  if pt > last.wall: wall = pt, counter = 0
  else:              wall = last.wall, counter = last.counter + 1
收到远端 hlc r（receive）:
  pt = now_ms()
  wall' = max(last.wall, r.wall, pt)
  counter' = 若 wall' 与 last.wall、r.wall 都相等 → max(last.c, r.c)+1
             若只等于 last.wall → last.c+1；若只等于 r.wall → r.c+1；否则 0
```

- `nodeId` = `deviceId` 去掉连字符后的前 8 位。
- counter 超过 9999 时，把 wall 加 1 毫秒并将 counter 归零。
- 远端 wall 比本地时钟超前 **24 小时以上**时，拒绝该记录（`rejected: CLOCK_SKEW`），并在客户端记录诊断日志。
- 没有 HLC 的历史数据：用 `updatedAt`（没有则用 `createdAt`）合成 `<ms>-0000-00000000`。

## 4. 冲突规则

### 4.1 通用 LWW

同一 `(type, id)`，**HLC 大者胜**。`deleted=true` 也参与比较：比墓碑新的写入会复活记录（例如在 A 设备删除后，B 设备离线期间又编辑了它）。

### 4.2 墓碑

- 本地删除必须产生墓碑并推送，不能只是本地消失。
- 服务端墓碑保留 **180 天**。
- 删除 `Article` 时，客户端负责同时给它的 `Segment`、`LyricsMeta`、`BookChapter` 写墓碑；服务端不做级联。

### 4.3 Segment

- 同一篇文章重新切分时，`segmentationRevision` 加 1，旧版本 segment 全部写墓碑，新版本整体推送。
- 应用远端 segment 时：
  - 远端 revision **大于**本地 → 用远端版本整体替换本地该文章的所有 segment；
  - 远端 revision **等于**本地 → 按字段补全：本地为空的 `translation`、`readingText`、`explanation` 用远端值填上，其余字段按 LWW 处理；
  - 远端 revision **小于**本地 → 丢弃远端记录。

## 5. HTTP API

公共请求头：

```
Authorization: Bearer <access token>      （网页可用 Cookie 会话）
X-OpenKoto-Protocol: 1
X-OpenKoto-Client: <platform>/<version>    例：ios/1.5.0、desktop/0.7.0、web/1.0.0、cli/0.1.0
```

### 5.1 `GET /api/v1/sync/pull`

查询参数：`cursor`（可选，缺省表示从头拉取）、`limit`（默认 500，最大 1000）、`types`（可选，逗号分隔）。

响应 `200`：

```json
{ "records": [ /* 按 rev 升序 */ ], "cursor": "c_1044", "hasMore": false, "serverTime": "…" }
```

- 单次响应不超过 1000 条且不超过 4 MB；客户端在 `hasMore=true` 时继续拉取。
- 使用 `types` 过滤时，返回的 cursor 只对这组 types 有效，客户端需要按过滤条件分别保存 cursor。

### 5.2 `POST /api/v1/sync/push`

```json
{
  "deviceId": "…",
  "ops": [
    { "opId": "uuid", "type": "Vocabulary", "id": "…", "baseRev": 1042,
      "hlc": "…", "deleted": false, "payload": {} }
  ]
}
```

- 单次最多 500 个 op，请求体不超过 4 MB。
- `baseRev`：客户端最后见到的该记录的 rev；新建记录填 0。

每个 op 的处理规则（按数组顺序依次处理）：

| 条件 | 结果 |
|---|---|
| `opId` 已处理过（30 天内） | 返回上次的结果（幂等） |
| type 未知 / payload 非法 / 超过 512 KB | `rejected`，并返回对应 code |
| type 为 `ReviewEvent` 且 id 已存在 | `applied`，rev 为已有记录的 rev（幂等，不修改） |
| 记录不存在，或 `baseRev == 当前 rev` | `applied`，分配新 rev |
| `baseRev < 当前 rev`，且 `op.hlc > 当前 hlc` | `applied`（LWW 获胜），分配新 rev |
| `baseRev < 当前 rev`，且 `op.hlc <= 当前 hlc` | `conflict`，附带当前记录 `current` |
| 超出配额（§7） | `rejected: QUOTA_EXCEEDED` |

响应 `200`：

```json
{
  "results": [
    { "opId": "…", "status": "applied", "rev": 1050 },
    { "opId": "…", "status": "conflict", "rev": 1047, "current": { /* 完整记录 */ } },
    { "opId": "…", "status": "rejected", "code": "PAYLOAD_TOO_LARGE" }
  ],
  "cursor": "c_1051"
}
```

客户端收到 `conflict` 后，把 `current` 当作一条 pull 到的记录应用到本地，重新计算合并结果，再以 `current.rev` 作为 `baseRev` 重推。每个同步周期最多重推 2 轮。

### 5.3 `GET /api/v1/sync/stats`

```json
{ "counts": { "Vocabulary": 180 }, "bytes": 1048576, "blobBytes": 0, "plan": "free",
  "limits": { "vocabulary": 200, "books": 5, "bookFileBytes": 10485760, "lyrics": 30, "articles": 30 } }
```

### 5.4 Blob

- `POST /api/v1/sync/blobs`，请求体 `{ "type": "...", "id": "...", "size": 123, "sha256": "..." }`，返回 `{ "blobKey": "...", "uploadUrl": "...", "expiresAt": "..." }`。
- 客户端把 gzip 压缩后的 payload 用 `PUT` 上传到 `uploadUrl`，然后在 push 的 op 里携带 `blobKey`，不再带 `payload`。
- pull 返回该记录时带 `blobUrl`（短期有效），客户端下载后自行解压。

### 5.5 错误

HTTP 层错误的响应体统一为 `{ "error": { "code": "…", "message": "…" } }`。

| HTTP | code | 客户端处理 |
|---|---|---|
| 400 | `BAD_REQUEST` | 属于 bug，上报诊断 |
| 401 | `UNAUTHENTICATED` / `TOKEN_EXPIRED` | 刷新 token 后重试一次；仍然失败则要求重新登录 |
| 403 | `FORBIDDEN` | 缺少所需的 scope 或权益 |
| 410 | `CURSOR_EXPIRED` | 全量重建（§8） |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体过大，拆小批次 |
| 426 | `CLIENT_TOO_OLD` | 提示升级 |
| 429 | `RATE_LIMITED` | 按 `Retry-After` 退避 |
| 5xx | `INTERNAL` | 指数退避（1s、2s、4s…… 最长 5 分钟） |

op 级错误码：`UNKNOWN_TYPE`、`INVALID_PAYLOAD`、`PAYLOAD_TOO_LARGE`、`QUOTA_EXCEEDED`、`CLOCK_SKEW`、`IMMUTABLE`（尝试修改或删除已存在的 ReviewEvent）。

## 6. 复习事件与 FSRS 重放

- `ReviewEvent` 不可修改、不可删除；卡片被删除时，它的事件**保留**（SRS 规范 §1.3）。
- 撤销一次复习：追加一条新事件，`voidsEventId` 指向被撤销的事件，`grade` 填 0。重放时跳过被作废的事件，作废事件本身也不参与计算。
- 客户端应用了某张卡的新事件后，必须对该卡执行**完整重放**：
  1. 取出这张卡的全部有效事件，按 `(reviewedAt, hlc, id)` 升序排序；
  2. 从卡片的初始状态（`new`，或 SM-2 迁移种子）开始逐条执行 FSRS-6。每条事件使用**它自己记录的** `dateLocal`（用于计算间隔天数）和 `desiredRetention`，不使用当前设备的时区和设置；缺少这两个字段的旧事件，才退回用本地设置计算。这样任何设备重放的结果都完全一致；
  3. 用结果覆盖卡片的 `srsState / stability / difficulty / dueDate / lastReviewedAt / reviewCount`。
- 重放结果只写本地；卡片的 LWW 字段仍按 §4.1 同步。**任何一端都不得依据 payload 里的 SRS 字段覆盖本地重放的结果。**

## 7. 配额（服务端强制）

| 套餐 | 生词 | 书 | 单本文件 | 文件总量 | 歌词 | 文章 |
|---|---|---|---|---|---|---|
| free | 200 | 5 | 10 MB | 50 MB | 30 | 30 |
| plus | ∞ | ∞ | 50 MB | 2 GB | ∞ | ∞ |
| pro | ∞ | ∞ | 50 MB | 10 GB | ∞ | ∞ |

- 只对**新建**计数（修改已有记录不受限）；墓碑不计数。
- 统计口径：`Vocabulary`、`Book`；歌词为 `sourceType=lyrics` 的 `Article`；文章为其余非章节类型的 `Article`（`BookChapter` 指向的文章不计入）。
- 超出配额时，op 返回 `rejected: QUOTA_EXCEEDED`，客户端保留本地数据，并在 UI 上提示。

## 8. 客户端算法

```
sync():
  1. loop: pull(cursor) → 按 mergeOrder 应用 → 保存 cursor → 直到 hasMore=false
     410 → fullRebuild()
  2. ops = 本地 dirty 记录（按 mergeOrder 排序，每 500 条一批）
  3. push(ops) → applied: 记录 rev，清除 dirty；conflict: 应用 current 后重新合并，留待重推
  4. 若有 conflict 且本周期已重推的轮数 < 2 → 回到第 3 步
  5. 对所有新到事件涉及的卡片执行重放

fullRebuild():
  1. 以 cursor=null 全量 pull
  2. 本地有、云端没有、且不在墓碑中的记录 → 视为新建，标记 dirty
  3. 执行正常 sync
```

触发时机：App 启动、回到前台、本地写入后防抖 3 秒、每 5 分钟、手动触发、实时通知（WebSocket）。

## 9. 首次上传

- 新账号或新设备首次登录时，先执行一次完整 pull，再把本地全部记录标记为 dirty 后推送。
- 本地和云端各有一张相同单词的卡片（id 不同）时，按 SRS 规范 §1.4 的去重规则合并：保留 `createdAt` 较早的一张，把另一张卡的事件改指向保留的卡（写新事件并作废旧事件），然后给被合并掉的那张卡写墓碑。

## 10. 版本

- 协议版本通过请求头 `X-OpenKoto-Protocol` 传递。服务端至少兼容当前版本和上一个版本；更旧的版本返回 426。
- payload 新增可选字段不算破坏性变更；删除字段或修改字段语义需要升级协议版本。
