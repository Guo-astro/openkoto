import Foundation
import GRDB
import OKModels

/// 行级数据损坏（如非法 UUID / 未知枚举值）。
/// 设计文档 §3.2：未知值必须显式报错，不能静默映射成默认值。
public enum PersistenceError: Error, Sendable {
    case corruptRow(table: String, id: String, reason: String)
}

/// SQLite / JSON 列统一编解码：snake_case + RFC3339 日期 + 确定性键序。
enum WireJSON {
    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

/// `segment.explanation_json` 列的存储信封：结构化精讲 + 溯源元数据（§3.2）。
/// 内置示例文章的预置精讲无元数据（meta 各字段为 nil）。
public struct ExplanationEnvelope: Codable, Sendable, Hashable {
    public var explanation: SegmentExplanation
    public var targetLanguage: String?
    public var providerId: String?
    public var modelId: String?
    public var promptVersion: String?
    public var generatedAt: Date?
    public var sourceTextHash: String?

    public init(explanation: SegmentExplanation, meta: ExplanationMeta?) {
        self.explanation = explanation
        self.targetLanguage = meta?.targetLanguage
        self.providerId = meta?.providerId
        self.modelId = meta?.modelId
        self.promptVersion = meta?.promptVersion
        self.generatedAt = meta?.generatedAt
        self.sourceTextHash = meta?.sourceTextHash
    }
}

// MARK: - 工具

func uuidString(_ id: UUID) -> String { id.uuidString.lowercased() }

func parseUUID(_ string: String, table: String) throws -> UUID {
    guard let id = UUID(uuidString: string) else {
        throw PersistenceError.corruptRow(table: table, id: string, reason: "invalid uuid")
    }
    return id
}

/// 收藏去重用词形规范化：去首尾空白 + NFKC 兼容分解合成 + 小写。
public func normalizedWord(_ word: String) -> String {
    word.trimmingCharacters(in: .whitespacesAndNewlines)
        .precomposedStringWithCompatibilityMapping
        .lowercased()
}

// MARK: - article

struct ArticleRecord: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "article"

    var id: String
    var title: String
    var content: String
    var sourceType: String?
    var sourceURL: String?
    var createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, title, content
        case sourceType = "source_type"
        case sourceURL = "source_url"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(_ article: Article, now: Date) {
        id = uuidString(article.id)
        title = article.title
        content = article.content
        sourceType = article.sourceType?.rawValue
        sourceURL = article.sourceURL
        createdAt = article.createdAt
        updatedAt = now
    }

    func domainModel() throws -> Article {
        // 不认识的来源按普通文章读：`loadAll()` 是全表 map，一行抛错就是整个书库加载失败，
        // 而别的客户端同步来的新来源类型（将来新增的）完全可能落到这里。
        let resolvedSourceType: SourceType? = sourceType.map { SourceType(rawValue: $0) ?? .article }
        return Article(
            id: try parseUUID(id, table: Self.databaseTableName),
            title: title,
            content: content,
            sourceType: resolvedSourceType,
            sourceURL: sourceURL,
            createdAt: createdAt
        )
    }
}

// MARK: - segment

struct SegmentRecord: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "segment"

    var id: String
    var articleId: String
    var orderIndex: Int
    var text: String
    var readingText: String?
    var translation: String?
    var explanationJson: String?
    var isNewParagraph: Bool
    /// 媒体文稿的句级时间轴（秒）。文章与书籍章节恒为 nil。
    var startTime: Double?
    var endTime: Double?
    var createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, text, translation
        case articleId = "article_id"
        case orderIndex = "order_index"
        case readingText = "reading_text"
        case explanationJson = "explanation_json"
        case isNewParagraph = "is_new_paragraph"
        case startTime = "start_time"
        case endTime = "end_time"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(_ segment: ArticleSegment, meta: ExplanationMeta?, now: Date) throws {
        id = uuidString(segment.id)
        articleId = uuidString(segment.articleId)
        orderIndex = segment.order
        text = segment.text
        readingText = segment.readingText
        translation = segment.translation
        if let explanation = segment.explanation {
            let envelope = ExplanationEnvelope(explanation: explanation, meta: meta)
            explanationJson = String(
                decoding: try WireJSON.encoder.encode(envelope), as: UTF8.self)
        } else {
            explanationJson = nil
        }
        isNewParagraph = segment.isNewParagraph
        startTime = segment.startTime
        endTime = segment.endTime
        createdAt = segment.createdAt
        updatedAt = now
    }

    func domainModel() throws -> ArticleSegment {
        let explanation: SegmentExplanation? = try explanationJson.map { json in
            do {
                return try WireJSON.decoder
                    .decode(ExplanationEnvelope.self, from: Data(json.utf8)).explanation
            } catch {
                throw PersistenceError.corruptRow(
                    table: Self.databaseTableName, id: id,
                    reason: "explanation_json decode failed: \(error)")
            }
        }
        return ArticleSegment(
            id: try parseUUID(id, table: Self.databaseTableName),
            articleId: try parseUUID(articleId, table: Self.databaseTableName),
            order: orderIndex,
            text: text,
            readingText: readingText,
            translation: translation,
            explanation: explanation,
            isNewParagraph: isNewParagraph,
            startTime: startTime,
            endTime: endTime,
            createdAt: createdAt
        )
    }
}

// MARK: - favorite_vocabulary

struct FavoriteVocabularyRecord: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "favorite_vocabulary"

    var id: String
    var word: String
    var normalizedWord: String
    var meaning: String
    var usage: String?
    var explanation: String?
    var example: String?
    var reading: String?
    var sourceArticleId: String?
    var sourceArticleTitle: String?
    var sourceSegmentId: String?
    var srsState: String
    var stability: Double
    var difficulty: Double
    var schedulerVersion: String?
    var suspendedAt: Date?
    var dueDate: String
    var lastReviewedAt: Date?
    var reviewCount: Int
    var createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, word, meaning, usage, explanation, example, reading, stability, difficulty
        case normalizedWord = "normalized_word"
        case sourceArticleId = "source_article_id"
        case sourceArticleTitle = "source_article_title"
        case sourceSegmentId = "source_segment_id"
        case srsState = "srs_state"
        case schedulerVersion = "scheduler_version"
        case suspendedAt = "suspended_at"
        case dueDate = "due_date"
        case lastReviewedAt = "last_reviewed_at"
        case reviewCount = "review_count"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(_ favorite: FavoriteVocabulary, now: Date) {
        id = uuidString(favorite.id)
        word = favorite.word
        normalizedWord = OKPersistence.normalizedWord(favorite.word)
        meaning = favorite.meaning
        usage = favorite.usage
        explanation = favorite.explanation
        example = favorite.example
        reading = favorite.reading
        sourceArticleId = favorite.sourceArticleId.map(uuidString)
        sourceArticleTitle = favorite.sourceArticleTitle
        sourceSegmentId = favorite.sourceSegmentId.map(uuidString)
        srsState = favorite.srsState.rawValue
        stability = favorite.stability
        difficulty = favorite.difficulty
        schedulerVersion = favorite.schedulerVersion
        suspendedAt = favorite.suspendedAt
        dueDate = favorite.dueDate
        lastReviewedAt = favorite.lastReviewedAt
        reviewCount = favorite.reviewCount
        createdAt = favorite.createdAt
        updatedAt = now
    }

    /// - Parameter packIds: 由 `word_pack_membership` 表查询后传入。
    func domainModel(packIds: [UUID]) throws -> FavoriteVocabulary {
        guard let state = SRSState(rawValue: srsState) else {
            throw PersistenceError.corruptRow(
                table: Self.databaseTableName, id: id, reason: "unknown srs_state \(srsState)")
        }
        return FavoriteVocabulary(
            id: try parseUUID(id, table: Self.databaseTableName),
            word: word,
            meaning: meaning,
            usage: usage,
            explanation: explanation,
            example: example,
            reading: reading,
            sourceArticleId: try sourceArticleId.map {
                try parseUUID($0, table: Self.databaseTableName)
            },
            sourceArticleTitle: sourceArticleTitle,
            sourceSegmentId: try sourceSegmentId.map {
                try parseUUID($0, table: Self.databaseTableName)
            },
            packIds: packIds,
            srsState: state,
            stability: stability,
            difficulty: difficulty,
            schedulerVersion: schedulerVersion,
            suspendedAt: suspendedAt,
            dueDate: dueDate,
            lastReviewedAt: lastReviewedAt,
            reviewCount: reviewCount,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }
}

// MARK: - word_pack

struct WordPackRecord: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "word_pack"

    var id: String
    var name: String
    var description: String?
    var coverUrl: String?
    var author: String?
    var languageFrom: String?
    var languageTo: String?
    var tagsJson: String
    var version: String?
    var isSystem: Bool
    var createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, name, description, author, version
        case coverUrl = "cover_url"
        case languageFrom = "language_from"
        case languageTo = "language_to"
        case tagsJson = "tags_json"
        case isSystem = "is_system"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(_ pack: WordPack, now: Date) throws {
        id = uuidString(pack.id)
        name = pack.name
        description = pack.packDescription
        coverUrl = pack.coverURL
        author = pack.author
        languageFrom = pack.languageFrom
        languageTo = pack.languageTo
        tagsJson = String(decoding: try WireJSON.encoder.encode(pack.tags), as: UTF8.self)
        version = pack.version
        isSystem = pack.isSystem
        createdAt = pack.createdAt
        updatedAt = now
    }

    func domainModel() throws -> WordPack {
        let tags: [String]
        do {
            tags = try WireJSON.decoder.decode([String].self, from: Data(tagsJson.utf8))
        } catch {
            throw PersistenceError.corruptRow(
                table: Self.databaseTableName, id: id, reason: "tags_json decode failed: \(error)")
        }
        return WordPack(
            id: try parseUUID(id, table: Self.databaseTableName),
            name: name,
            packDescription: description,
            coverURL: coverUrl,
            author: author,
            languageFrom: languageFrom,
            languageTo: languageTo,
            tags: tags,
            version: version,
            isSystem: isSystem,
            createdAt: createdAt,
            updatedAt: updatedAt
        )
    }
}

// MARK: - word_pack_membership

struct WordPackMembershipRecord: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "word_pack_membership"

    var vocabularyId: String
    var packId: String
    var createdAt: Date

    enum CodingKeys: String, CodingKey {
        case vocabularyId = "vocabulary_id"
        case packId = "pack_id"
        case createdAt = "created_at"
    }
}

// MARK: - review_log

struct ReviewLogRecord: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "review_log"

    var id: String
    var vocabularyId: String
    var reviewedAt: Date
    var dateLocal: String
    var grade: Int
    var elapsedDays: Int
    var previousState: String
    var schedulerVersion: String
    var desiredRetention: Double
    var resultStability: Double
    var resultDifficulty: Double
    var resultIntervalDays: Int
    var resultState: String
    /// 撤销标记指向的事件（migration v12）。
    var voidsEventId: String?
    /// 该事件在 OpenKoto 云上的 HLC（重放的第二排序键；未同步过的为 nil，按空串排）。
    var hlc: String?

    enum CodingKeys: String, CodingKey {
        case id, grade, hlc
        case voidsEventId = "voids_event_id"
        case vocabularyId = "vocabulary_id"
        case reviewedAt = "reviewed_at"
        case dateLocal = "date_local"
        case elapsedDays = "elapsed_days"
        case previousState = "previous_state"
        case schedulerVersion = "scheduler_version"
        case desiredRetention = "desired_retention"
        case resultStability = "result_stability"
        case resultDifficulty = "result_difficulty"
        case resultIntervalDays = "result_interval_days"
        case resultState = "result_state"
    }

    init(_ event: ReviewEvent) {
        id = uuidString(event.id)
        vocabularyId = uuidString(event.vocabularyId)
        reviewedAt = event.reviewedAt
        dateLocal = event.dateLocal
        grade = event.grade
        elapsedDays = event.elapsedDays
        previousState = event.previousState.rawValue
        schedulerVersion = event.schedulerVersion
        desiredRetention = event.desiredRetention
        resultStability = event.resultStability
        resultDifficulty = event.resultDifficulty
        resultIntervalDays = event.resultIntervalDays
        resultState = event.resultState.rawValue
        voidsEventId = event.voidsEventId.map(uuidString)
        hlc = nil
    }

    func domainModel() throws -> ReviewEvent {
        guard let previous = SRSState(rawValue: previousState),
              let result = SRSState(rawValue: resultState)
        else {
            throw PersistenceError.corruptRow(
                table: Self.databaseTableName, id: id, reason: "unknown srs_state")
        }
        return ReviewEvent(
            id: try parseUUID(id, table: Self.databaseTableName),
            vocabularyId: try parseUUID(vocabularyId, table: Self.databaseTableName),
            reviewedAt: reviewedAt,
            dateLocal: dateLocal,
            grade: grade,
            elapsedDays: elapsedDays,
            previousState: previous,
            schedulerVersion: schedulerVersion,
            desiredRetention: desiredRetention,
            resultStability: resultStability,
            resultDifficulty: resultDifficulty,
            resultIntervalDays: resultIntervalDays,
            resultState: result,
            voidsEventId: try voidsEventId.map { try parseUUID($0, table: Self.databaseTableName) }
        )
    }
}

// MARK: - reading_session

struct ReadingSessionRecord: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "reading_session"

    var id: String
    var articleId: String?
    var dateLocal: String
    var startedAt: Date
    var seconds: Int

    enum CodingKeys: String, CodingKey {
        case id, seconds
        case articleId = "article_id"
        case dateLocal = "date_local"
        case startedAt = "started_at"
    }

    init(_ session: ReadingSession) {
        id = uuidString(session.id)
        articleId = session.articleId.map(uuidString)
        dateLocal = session.dateLocal
        startedAt = session.startedAt
        seconds = session.seconds
    }

    func domainModel() throws -> ReadingSession {
        ReadingSession(
            id: try parseUUID(id, table: Self.databaseTableName),
            articleId: try articleId.map { try parseUUID($0, table: Self.databaseTableName) },
            dateLocal: dateLocal,
            startedAt: startedAt,
            seconds: seconds
        )
    }
}


// MARK: - word_gloss

/// 查词缓存行。主键即归一化词形——同一个词只留最新一次查询结果。
struct WordGlossRecord: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "word_gloss"

    var normalizedWord: String
    var word: String
    var meaning: String
    var usage: String?
    var example: String?
    var reading: String?
    /// 失效维度（prompt 版本 + 模型 + 目标语言），见 AppDatabase v11 的注释。
    var context: String
    var createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case word, meaning, usage, example, reading, context
        case normalizedWord = "normalized_word"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(_ item: VocabularyItem, context: String, now: Date) {
        normalizedWord = OKPersistence.normalizedWord(item.word)
        word = item.word
        meaning = item.meaning
        usage = item.usage
        example = item.example
        reading = item.reading
        self.context = context
        createdAt = now
        updatedAt = now
    }

    func domainModel() -> VocabularyItem {
        VocabularyItem(word: word, meaning: meaning, usage: usage, example: example, reading: reading)
    }
}
