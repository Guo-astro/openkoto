import Foundation

// 领域模型：强类型（UUID / Date / enum）。
// 跨端传输与 SQLite 编解码使用 snake_case WireDTO（M2 引入），
// 桌面字段语义见 textlingo-desktop/src-tauri/src/types.rs 与设计文档 §3.2。

public enum SourceType: String, Codable, Sendable, CaseIterable {
    case article
    case web
    /// 歌词（LRC / 带时间轴的纯文本），附带一条 `LyricsMeta`（同步协议 §2.2）。
    case lyrics
    /// 网页 / 桌面导入的书籍章节正文（归属见 `BookChapter`）。
    case book

    /// 宽松解码：不认识的来源（别的客户端将来新增的）按普通文章处理。
    /// 严格解码会让整篇文章被同步静默丢弃，而它的正文本身完全可读。
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SourceType(rawValue: raw) ?? .article
    }
}

public enum SRSState: String, Codable, Sendable {
    case new
    case learning
    case review
}

public struct Article: Codable, Identifiable, Sendable, Hashable {
    public var id: UUID
    public var title: String
    public var content: String
    public var sourceType: SourceType?
    public var sourceURL: String?
    public var createdAt: Date

    public init(
        id: UUID = UUID(),
        title: String,
        content: String,
        sourceType: SourceType? = .article,
        sourceURL: String? = nil,
        createdAt: Date = .now
    ) {
        self.id = id
        self.title = title
        self.content = content
        self.sourceType = sourceType
        self.sourceURL = sourceURL
        self.createdAt = createdAt
    }
}

public struct ArticleSegment: Codable, Identifiable, Sendable, Hashable {
    public var id: UUID
    public var articleId: UUID
    public var order: Int
    public var text: String
    /// 注音/furigana 行（独立一行显示，非 ruby）
    public var readingText: String?
    public var translation: String?
    public var explanation: SegmentExplanation?
    public var isNewParagraph: Bool
    /// 在媒体中的起止时刻（秒）。只有视频/音频的文稿句子有值，文章与书籍章节恒为 nil。
    ///
    /// **这是学习层的时间轴**：一句话对应一个区间，由词级/cue 级时间戳对齐得出。
    /// 播放同步一律以它为准；更细的词级时间戳不进库（见 `OKMedia.TranscriptAligner`）。
    public var startTime: Double?
    public var endTime: Double?
    public var createdAt: Date

    public init(
        id: UUID = UUID(),
        articleId: UUID,
        order: Int,
        text: String,
        readingText: String? = nil,
        translation: String? = nil,
        explanation: SegmentExplanation? = nil,
        isNewParagraph: Bool = false,
        startTime: Double? = nil,
        endTime: Double? = nil,
        createdAt: Date = .now
    ) {
        self.id = id
        self.articleId = articleId
        self.order = order
        self.text = text
        self.readingText = readingText
        self.translation = translation
        self.explanation = explanation
        self.isNewParagraph = isNewParagraph
        self.startTime = startTime
        self.endTime = endTime
        self.createdAt = createdAt
    }
}

public struct SegmentExplanation: Codable, Sendable, Hashable {
    public var translation: String
    public var explanation: String
    public var readingText: String?
    public var vocabulary: [VocabularyItem]
    public var grammarPoints: [GrammarPoint]
    public var culturalContext: String?
    public var difficultyLevel: String?   // beginner | intermediate | advanced
    public var learningTips: String?

    public init(
        translation: String,
        explanation: String,
        readingText: String? = nil,
        vocabulary: [VocabularyItem] = [],
        grammarPoints: [GrammarPoint] = [],
        culturalContext: String? = nil,
        difficultyLevel: String? = nil,
        learningTips: String? = nil
    ) {
        self.translation = translation
        self.explanation = explanation
        self.readingText = readingText
        self.vocabulary = vocabulary
        self.grammarPoints = grammarPoints
        self.culturalContext = culturalContext
        self.difficultyLevel = difficultyLevel
        self.learningTips = learningTips
    }
}

/// 一次精讲生成的溯源元数据（设计文档 §3.2）：
/// 正文、目标语言或 Prompt 改变时可据此判定结果已过期。
/// 属性名用 `providerId`/`modelId`（小写 d）以保证 snake_case 编解码策略可往返。
public struct ExplanationMeta: Codable, Sendable, Hashable {
    public var targetLanguage: String
    public var providerId: String
    public var modelId: String
    public var promptVersion: String
    public var generatedAt: Date
    /// 原文 SHA-256 十六进制摘要
    public var sourceTextHash: String

    public init(
        targetLanguage: String,
        providerId: String,
        modelId: String,
        promptVersion: String,
        generatedAt: Date,
        sourceTextHash: String
    ) {
        self.targetLanguage = targetLanguage
        self.providerId = providerId
        self.modelId = modelId
        self.promptVersion = promptVersion
        self.generatedAt = generatedAt
        self.sourceTextHash = sourceTextHash
    }
}

/// 真实 AI 精讲的完整产物：结构化结果 + 溯源元数据。
public struct GeneratedExplanation: Sendable {
    public var explanation: SegmentExplanation
    public var meta: ExplanationMeta

    public init(explanation: SegmentExplanation, meta: ExplanationMeta) {
        self.explanation = explanation
        self.meta = meta
    }
}

public struct VocabularyItem: Codable, Sendable, Hashable {
    public var word: String
    public var meaning: String
    public var usage: String?
    public var example: String?
    public var reading: String?

    public init(word: String, meaning: String, usage: String? = nil,
                example: String? = nil, reading: String? = nil) {
        self.word = word
        self.meaning = meaning
        self.usage = usage
        self.example = example
        self.reading = reading
    }
}

public struct GrammarPoint: Codable, Sendable, Hashable {
    public var point: String
    public var explanation: String
    public var example: String?

    public init(point: String, explanation: String, example: String? = nil) {
        self.point = point
        self.explanation = explanation
        self.example = example
    }
}

public struct FavoriteVocabulary: Codable, Identifiable, Sendable, Hashable {
    public var id: UUID
    public var word: String
    public var meaning: String
    public var usage: String?
    public var explanation: String?
    public var example: String?
    public var reading: String?
    public var sourceArticleId: UUID?
    public var sourceArticleTitle: String?
    /// 收藏时所在的句子。媒体字幕句带 `startTime`，所以有了它就能一路跳回
    /// "原视频的那一秒"。不建外键：句子被重新切分后卡片仍应存活。
    public var sourceSegmentId: UUID?
    public var packIds: [UUID]

    // FSRS 状态(引擎 OKSRS/FSRS.swift,规范 docs/specs/vocabulary-srs-spec.md §1.1)
    public var srsState: SRSState
    /// FSRS 记忆稳定性;0 = 未初始化(new 卡)
    public var stability: Double
    /// FSRS 难度 ∈ [1,10];0 = 未初始化
    public var difficulty: Double
    /// "fsrs6"
    public var schedulerVersion: String?
    /// 非空 = 已掌握/暂停复习;队列排除,恢复时置 nil
    public var suspendedAt: Date?
    /// 本地日期 "YYYY-MM-DD",天粒度(与桌面语义一致)
    public var dueDate: String
    public var lastReviewedAt: Date?
    public var reviewCount: Int
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: UUID = UUID(),
        word: String,
        meaning: String,
        usage: String? = nil,
        explanation: String? = nil,
        example: String? = nil,
        reading: String? = nil,
        sourceArticleId: UUID? = nil,
        sourceArticleTitle: String? = nil,
        sourceSegmentId: UUID? = nil,
        packIds: [UUID] = [],
        srsState: SRSState = .new,
        stability: Double = 0,
        difficulty: Double = 0,
        schedulerVersion: String? = "fsrs6",
        suspendedAt: Date? = nil,
        dueDate: String = "",
        lastReviewedAt: Date? = nil,
        reviewCount: Int = 0,
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.word = word
        self.meaning = meaning
        self.usage = usage
        self.explanation = explanation
        self.example = example
        self.reading = reading
        self.sourceArticleId = sourceArticleId
        self.sourceArticleTitle = sourceArticleTitle
        self.sourceSegmentId = sourceSegmentId
        self.packIds = packIds
        self.srsState = srsState
        self.stability = stability
        self.difficulty = difficulty
        self.schedulerVersion = schedulerVersion
        self.suspendedAt = suspendedAt
        self.dueDate = dueDate
        self.lastReviewedAt = lastReviewedAt
        self.reviewCount = reviewCount
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

extension FavoriteVocabulary {
    enum CodingKeys: String, CodingKey {
        case id, word, meaning, usage, explanation, example, reading
        case sourceArticleId, sourceArticleTitle, sourceSegmentId, packIds
        case srsState, stability, difficulty, schedulerVersion, suspendedAt
        case dueDate, lastReviewedAt, reviewCount, createdAt, updatedAt
    }

    /// 宽松解码：同步协议 §2.2 的必填字段之外都给默认值。
    ///
    /// 网页 / 桌面推上来的生词**没有 `packIds`**（词包成员是独立的
    /// `WordPackMembership` 记录），严格解码会让这些卡片在 iOS 上被静默跳过。
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        word = try c.decode(String.self, forKey: .word)
        meaning = try c.decodeIfPresent(String.self, forKey: .meaning) ?? ""
        usage = try c.decodeIfPresent(String.self, forKey: .usage)
        explanation = try c.decodeIfPresent(String.self, forKey: .explanation)
        example = try c.decodeIfPresent(String.self, forKey: .example)
        reading = try c.decodeIfPresent(String.self, forKey: .reading)
        sourceArticleId = try? c.decodeIfPresent(UUID.self, forKey: .sourceArticleId)
        sourceArticleTitle = try c.decodeIfPresent(String.self, forKey: .sourceArticleTitle)
        sourceSegmentId = try? c.decodeIfPresent(UUID.self, forKey: .sourceSegmentId)
        packIds = (try? c.decodeIfPresent([UUID].self, forKey: .packIds)) ?? []
        srsState = (try? c.decodeIfPresent(SRSState.self, forKey: .srsState)) ?? .new
        stability = try c.decodeIfPresent(Double.self, forKey: .stability) ?? 0
        difficulty = try c.decodeIfPresent(Double.self, forKey: .difficulty) ?? 0
        schedulerVersion = try c.decodeIfPresent(String.self, forKey: .schedulerVersion)
        suspendedAt = try c.decodeIfPresent(Date.self, forKey: .suspendedAt)
        dueDate = try c.decodeIfPresent(String.self, forKey: .dueDate) ?? ""
        lastReviewedAt = try c.decodeIfPresent(Date.self, forKey: .lastReviewedAt)
        reviewCount = try c.decodeIfPresent(Int.self, forKey: .reviewCount) ?? 0
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt
    }
}

/// 词包(镜像桌面 types.rs::WordPack;规范 §1.2)。
public struct WordPack: Codable, Identifiable, Sendable, Hashable {
    /// 系统默认词包("未分组")的固定 id。
    /// 桌面端用字符串 "system-ungrouped";iOS 主键为 UUID,取固定值,语义等价(规范 §1.2)。
    public static let systemUngroupedID = UUID(uuidString: "00000000-0000-4000-8000-0000756E6772")!

    public var id: UUID
    public var name: String
    public var packDescription: String?
    public var coverURL: String?
    public var author: String?
    public var languageFrom: String?
    public var languageTo: String?
    public var tags: [String]
    public var version: String?
    public var isSystem: Bool
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: UUID = UUID(),
        name: String,
        packDescription: String? = nil,
        coverURL: String? = nil,
        author: String? = nil,
        languageFrom: String? = nil,
        languageTo: String? = nil,
        tags: [String] = [],
        version: String? = nil,
        isSystem: Bool = false,
        createdAt: Date = .now,
        updatedAt: Date = .now
    ) {
        self.id = id
        self.name = name
        self.packDescription = packDescription
        self.coverURL = coverURL
        self.author = author
        self.languageFrom = languageFrom
        self.languageTo = languageTo
        self.tags = tags
        self.version = version
        self.isSystem = isSystem
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// 复习事件(append-only、不可变;规范 §1.3)。
/// 事件独立于卡片生命周期,未来云同步以事件为单元重放重算。
public struct ReviewEvent: Codable, Identifiable, Sendable, Hashable {
    public var id: UUID
    public var vocabularyId: UUID
    /// UTC 时刻
    public var reviewedAt: Date
    /// 复习时的本地日期 "YYYY-MM-DD"
    public var dateLocal: String
    /// 1=Again 2=Hard 3=Good 4=Easy
    public var grade: Int
    public var elapsedDays: Int
    /// 复习前状态("new" 时计入"今日新学")
    public var previousState: SRSState
    public var schedulerVersion: String
    public var desiredRetention: Double
    public var resultStability: Double
    public var resultDifficulty: Double
    public var resultIntervalDays: Int
    public var resultState: SRSState
    /// 撤销标记（同步协议 §6）：非 nil 时本条是"作废 `voidsEventId` 那一条"的标记，
    /// `grade` 为 0。重放时标记本身与被它作废的事件都不参与计算。
    /// 事件只增不删，撤销只能靠追加这样一条。
    public var voidsEventId: UUID?

    public init(
        id: UUID = UUID(),
        vocabularyId: UUID,
        reviewedAt: Date,
        dateLocal: String,
        grade: Int,
        elapsedDays: Int,
        previousState: SRSState,
        schedulerVersion: String = "fsrs6",
        desiredRetention: Double,
        resultStability: Double,
        resultDifficulty: Double,
        resultIntervalDays: Int,
        resultState: SRSState,
        voidsEventId: UUID? = nil
    ) {
        self.voidsEventId = voidsEventId
        self.id = id
        self.vocabularyId = vocabularyId
        self.reviewedAt = reviewedAt
        self.dateLocal = dateLocal
        self.grade = grade
        self.elapsedDays = elapsedDays
        self.previousState = previousState
        self.schedulerVersion = schedulerVersion
        self.desiredRetention = desiredRetention
        self.resultStability = resultStability
        self.resultDifficulty = resultDifficulty
        self.resultIntervalDays = resultIntervalDays
        self.resultState = resultState
    }

    enum CodingKeys: String, CodingKey {
        case id, vocabularyId, reviewedAt, dateLocal, grade, elapsedDays, previousState
        case schedulerVersion, desiredRetention, resultStability, resultDifficulty
        case resultIntervalDays, resultState, voidsEventId
    }

    /// 解码是**宽松**的：只有 `id / vocabularyId / reviewedAt / grade` 必填。
    ///
    /// 事件会从别的客户端同步过来（网页的撤销标记、旧版桌面端的事件），
    /// 缺字段就整条解不开的话，那条复习会被静默跳过 —— 两端重放结果从此不一致。
    /// 缺的 `dateLocal` 记空串、`desiredRetention` 记 0：重放时视为"没记录"，
    /// 退回本机设置（与 `packages/core` 的 `replayCard` 同规则）。
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        vocabularyId = try c.decode(UUID.self, forKey: .vocabularyId)
        reviewedAt = try c.decode(Date.self, forKey: .reviewedAt)
        grade = try c.decode(Int.self, forKey: .grade)
        dateLocal = try c.decodeIfPresent(String.self, forKey: .dateLocal) ?? ""
        elapsedDays = try c.decodeIfPresent(Int.self, forKey: .elapsedDays) ?? 0
        previousState = (try? c.decodeIfPresent(SRSState.self, forKey: .previousState)) ?? .new
        schedulerVersion = try c.decodeIfPresent(String.self, forKey: .schedulerVersion) ?? "fsrs6"
        desiredRetention = try c.decodeIfPresent(Double.self, forKey: .desiredRetention) ?? 0
        resultStability = try c.decodeIfPresent(Double.self, forKey: .resultStability) ?? 0
        resultDifficulty = try c.decodeIfPresent(Double.self, forKey: .resultDifficulty) ?? 0
        resultIntervalDays = try c.decodeIfPresent(Int.self, forKey: .resultIntervalDays) ?? 0
        resultState = (try? c.decodeIfPresent(SRSState.self, forKey: .resultState)) ?? .new
        voidsEventId = try c.decodeIfPresent(UUID.self, forKey: .voidsEventId)
    }
}

extension ReviewEvent {
    /// 是撤销标记（同步协议 §6：`voidsEventId` 非空、grade 0）。
    public var isVoidMarker: Bool { voidsEventId != nil }

    /// 真正"算数"的复习：去重（按 id）、去掉撤销标记与被它作废的事件、去掉非法评分（1–4 之外）。
    ///
    /// 统计、打卡、"今日已复习"与 FSRS 重放**必须用同一套口径**（`packages/core`
    /// 的 `effectiveReviewEvents`）：否则网页上撤销的一次复习，在 iOS 统计里还算着，
    /// 而且 grade 0 会被图表归到 "easy" 那一栏。
    public static func effective(_ events: [ReviewEvent]) -> [ReviewEvent] {
        var seen: Set<UUID> = []
        let unique = events.filter { seen.insert($0.id).inserted }
        let voided = Set(unique.compactMap(\.voidsEventId))
        return unique.filter {
            $0.voidsEventId == nil && !voided.contains($0.id) && (1...4).contains($0.grade)
        }
    }
}

/// 复习统计(规范 §6,由事件日志 + 卡片状态推导)。
public struct ReviewStats: Sendable, Hashable {
    /// 今日"碰过"的卡数(规范 §6:按事件去重,不看评分)。统计页的活跃度用它。
    public var newToday: Int
    public var reviewToday: Int
    /// 今日**通过**(评分 ≥ good)的卡数。复习页的进度条用它:
    /// 答错的卡当天还会回来,在点"认识"之前不该算学完(规范 §6 派生计数)。
    public var passedNewToday: Int
    public var passedReviewToday: Int
    public var streakDays: Int
    public var total: Int
    public var countNew: Int
    public var countLearning: Int
    public var countReview: Int
    public var countSuspended: Int

    public init(
        newToday: Int = 0, reviewToday: Int = 0,
        passedNewToday: Int = 0, passedReviewToday: Int = 0,
        streakDays: Int = 0, total: Int = 0,
        countNew: Int = 0, countLearning: Int = 0, countReview: Int = 0, countSuspended: Int = 0
    ) {
        self.newToday = newToday
        self.reviewToday = reviewToday
        self.passedNewToday = passedNewToday
        self.passedReviewToday = passedReviewToday
        self.streakDays = streakDays
        self.total = total
        self.countNew = countNew
        self.countLearning = countLearning
        self.countReview = countReview
        self.countSuspended = countSuspended
    }
}
