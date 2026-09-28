import Foundation
import GRDB
import OKModels
import OKSRS
import os

/// 云端一条记录的载荷。引擎只管搬运，编解码与冲突判定都在这里。
public struct CloudPayload: Sendable {
    public let type: CloudRecordType
    public let id: String
    public let data: Data
    public let updatedAt: Date
    /// 云端记录的 HLC（仅 OpenKoto 云；CloudKit 为 nil）。复习事件用它做重放的第二排序键。
    public let hlc: String?

    public init(type: CloudRecordType, id: String, data: Data, updatedAt: Date, hlc: String? = nil) {
        self.type = type
        self.id = id
        self.data = data
        self.updatedAt = updatedAt
        self.hlc = hlc
    }
}

/// 推送收集的可选范围。默认值 = CloudKit 的既有行为（不动）。
///
/// OpenKoto 云协议（`docs/specs/sync-protocol-spec.md` §2.2）比 CloudKit 版多两类：
/// 阅读进度与词包成员关系。CloudKit 那边不加 —— 那会改变线上 iCloud 用户的
/// 记录集合，还要在 CloudKit Dashboard 里部署新的 record type。
public struct CloudPayloadOptions: Sendable, Equatable {
    public var includeBookProgress: Bool
    public var includeMemberships: Bool

    public init(includeBookProgress: Bool = false, includeMemberships: Bool = false) {
        self.includeBookProgress = includeBookProgress
        self.includeMemberships = includeMemberships
    }

    public static let cloudKit = CloudPayloadOptions()
    public static let openKoto = CloudPayloadOptions(
        includeBookProgress: true, includeMemberships: true)
}

/// 词包成员记录的 payload（协议 §2.2：`vocabularyId, packId`）。
///
/// 刻意**不带** `createdAt`：从云端合并进来的成员行 `created_at` 取的是合并时刻，
/// 带上它的话，每条拉下来的成员都会因为"内容变了"被原样推回去一次。
struct MembershipPayload: Codable {
    var vocabularyId: String
    var packId: String
}

extension ContentRepository {

    static let cloudLogger = Logger(subsystem: "app.openkoto", category: "CloudMerge")

    // MARK: - 哪些文章参与同步

    /// 排除固定版式书（`original_only`）的章节。
    ///
    /// 这类书抽不出正文，到了对端是**彻底死的**：原生模式被 `originalOnly` 禁死
    /// （`BookReaderView` 的 mode picker），原版模式又没有 EPUB 文件，
    /// 一个字都看不到 —— 书库里多一条打不开的条目，不如干脆不推。
    ///
    /// 其余章节与视频文稿**照常同步**：正文在 `article` 行里，
    /// `ChapterSegmenter.rubyText` 读不到原始文件会退回 `article.content`，
    /// 所以对端原生模式完整可读，只有原版模式与播放不可用（两处降级 UI 都已存在）。
    static let syncableArticleFilter = """
        id NOT IN (
          SELECT c.article_id FROM book_chapter c
          JOIN book b ON b.id = c.book_id
          WHERE b.original_only = 1
        )
        """

    static let syncableSegmentFilter = """
        article_id NOT IN (
          SELECT c.article_id FROM book_chapter c
          JOIN book b ON b.id = c.book_id
          WHERE b.original_only = 1
        )
        """

    // MARK: - 收集要推送的记录

    /// 水位线之后有变化的记录，编码成待推送载荷。
    ///
    /// 这里**不用 `dirty` 列**：那意味着要在所有 Repository 的每个写入点插一句标记，
    /// 几十处改动，且漏一处就是"这类数据永远不同步"的静默 bug。
    /// 水位线扫描的代价只是每次同步多读一遍表（几千行量级），换来写入路径零改动。
    public func pendingCloudPayloads(
        since watermark: Date?, options: CloudPayloadOptions = .cloudKit
    ) async throws -> [CloudPayload] {
        let encoder = CloudRecord.encoder()
        return try await database.writer.read { db in
            var payloads: [CloudPayload] = []

            func cutoff() -> Date? {
                watermark.map { $0.addingTimeInterval(-Self.watermarkOverlap) }
            }

            // 生词（含它的词包成员，成员单独成记录见下）
            let vocabRecords: [FavoriteVocabularyRecord]
            if let since = cutoff() {
                vocabRecords = try FavoriteVocabularyRecord
                    .filter(Column("updated_at") >= since).fetchAll(db)
            } else {
                vocabRecords = try FavoriteVocabularyRecord.fetchAll(db)
            }
            for record in vocabRecords {
                let packIds = try WordPackMembershipRecord
                    .filter(Column("vocabulary_id") == record.id)
                    .fetchAll(db)
                    .compactMap { UUID(uuidString: $0.packId) }
                guard let model = try? record.domainModel(packIds: packIds),
                    let data = try? encoder.encode(model)
                else { continue }
                payloads.append(
                    CloudPayload(
                        type: .vocabulary, id: record.id, data: data,
                        updatedAt: record.updatedAt))
            }

            // 词包（系统包不上云：每台设备自己会建，id 又是固定常量）
            let packRecords: [WordPackRecord]
            if let since = cutoff() {
                packRecords = try WordPackRecord.filter(Column("updated_at") >= since).fetchAll(db)
            } else {
                packRecords = try WordPackRecord.fetchAll(db)
            }
            for record in packRecords {
                guard let model = try? record.domainModel(), !model.isSystem,
                    model.id != WordPack.systemUngroupedID,
                    let data = try? encoder.encode(model)
                else { continue }
                payloads.append(
                    CloudPayload(
                        type: .wordPack, id: record.id, data: data, updatedAt: record.updatedAt))
            }

            // 文章 + 段落
            // 章节 / 文稿文章不上云，见 `syncableArticleFilter`。
            let syncableArticles = ArticleRecord.filter(sql: Self.syncableArticleFilter)
            let articleRecords: [ArticleRecord]
            if let since = cutoff() {
                articleRecords = try syncableArticles
                    .filter(Column("updated_at") >= since).fetchAll(db)
            } else {
                articleRecords = try syncableArticles.fetchAll(db)
            }
            for record in articleRecords {
                guard let model = try? record.domainModel(),
                    let data = try? encoder.encode(model)
                else { continue }
                payloads.append(
                    CloudPayload(
                        type: .article, id: record.id, data: data, updatedAt: record.updatedAt))
            }

            let syncableSegments = SegmentRecord.filter(sql: Self.syncableSegmentFilter)
            let segmentRecords: [SegmentRecord]
            if let since = cutoff() {
                segmentRecords = try syncableSegments
                    .filter(Column("updated_at") >= since).fetchAll(db)
            } else {
                segmentRecords = try syncableSegments.fetchAll(db)
            }
            for record in segmentRecords {
                guard let model = try? record.domainModel(),
                    let data = try? encoder.encode(model)
                else { continue }
                payloads.append(
                    CloudPayload(
                        type: .segment, id: record.id, data: data, updatedAt: record.updatedAt))
            }

            // 复习事件：只增不删，天然无冲突，是复习进度的真相所在。
            // 它没有 updated_at，用 reviewed_at 当水位线判据。
            let eventRecords: [ReviewLogRecord]
            if let since = cutoff() {
                eventRecords = try ReviewLogRecord
                    .filter(Column("reviewed_at") >= since).fetchAll(db)
            } else {
                eventRecords = try ReviewLogRecord.fetchAll(db)
            }
            for record in eventRecords {
                guard let model = try? record.domainModel(),
                    let data = try? encoder.encode(model)
                else { continue }
                payloads.append(
                    CloudPayload(
                        type: .reviewEvent, id: record.id, data: data,
                        updatedAt: record.reviewedAt))
            }

            // 书（不含固定版式）+ 章节归属。
            let syncableBooks = BookRecord.filter(Column("original_only") == false)
            let bookRecords: [BookRecord]
            if let since = cutoff() {
                bookRecords = try syncableBooks
                    .filter(Column("updated_at") >= since).fetchAll(db)
            } else {
                bookRecords = try syncableBooks.fetchAll(db)
            }
            for record in bookRecords {
                guard let model = try? record.domainModel(),
                    let data = try? encoder.encode(model)
                else { continue }
                payloads.append(
                    CloudPayload(
                        type: .book, id: record.id, data: data, updatedAt: record.updatedAt))

                // `book_chapter` **一个时间戳都没有**（表里只有业务列），水位线扫不到。
                // 跟着父书一起收：章节行除了 `is_segmented` 基本不变，
                // 而 `is_segmented` 只影响目录页徽章 —— 阅读页真正的判据是
                // 本地有没有 segment（`ContentStore.openArticle`）。
                let chapters = try BookChapterRecord
                    .filter(Column("book_id") == record.id)
                    .fetchAll(db)
                for chapter in chapters {
                    guard let chapterModel = try? chapter.domainModel(),
                        let chapterData = try? encoder.encode(chapterModel)
                    else { continue }
                    payloads.append(
                        CloudPayload(
                            type: .bookChapter, id: chapter.articleId, data: chapterData,
                            updatedAt: record.updatedAt))
                }
            }

            // 书签 / 划线 / 笔记：用户亲手造的内容，丢了就是丢数据。
            // 阅读位置（`book_progress`）刻意**不**同步：它不是内容，
            // 而两台同时读同一本时互相顶比不同步更烦人。
            let markRecords: [BookMarkRecord]
            if let since = cutoff() {
                markRecords = try BookMarkRecord
                    .filter(Column("updated_at") >= since).fetchAll(db)
            } else {
                markRecords = try BookMarkRecord.fetchAll(db)
            }
            for record in markRecords {
                guard let model = try? record.domainModel(),
                    let data = try? encoder.encode(model)
                else { continue }
                payloads.append(
                    CloudPayload(
                        type: .bookMark, id: record.id, data: data, updatedAt: record.updatedAt))
            }

            // 媒体 + 文稿归属。
            let mediaRecords: [MediaRecord]
            if let since = cutoff() {
                mediaRecords = try MediaRecord
                    .filter(Column("updated_at") >= since).fetchAll(db)
            } else {
                mediaRecords = try MediaRecord.fetchAll(db)
            }
            for record in mediaRecords {
                guard var model = try? record.domainModel() else { continue }
                // **security-scoped bookmark 绝不上云。** 它是设备本地的，
                // 传过去解析不出来，还会让对端的 `mediaFileURL` 反复走
                // `refreshBookmark` 那条死路。文件不在时该显示的是"媒体不可用"。
                model.bookmarkData = nil
                guard let data = try? encoder.encode(model) else { continue }
                payloads.append(
                    CloudPayload(
                        type: .media, id: record.id, data: data, updatedAt: record.updatedAt))

                // `media_part` 同样没有时间戳，跟着父 media 收。
                let parts = try MediaPartRecord
                    .filter(Column("media_id") == record.id)
                    .fetchAll(db)
                for part in parts {
                    guard let partModel = try? part.domainModel(),
                        let partData = try? encoder.encode(partModel)
                    else { continue }
                    payloads.append(
                        CloudPayload(
                            type: .mediaPart, id: part.articleId, data: partData,
                            updatedAt: record.updatedAt))
                }
            }

            // 阅读进度（仅 OpenKoto 云）。固定版式书本身不上云，它的进度推过去
            // 只会在对端永远停放（等一本不会来的书），所以一并排除。
            if options.includeBookProgress {
                let syncableProgress = BookProgressRecord.filter(
                    sql: "book_id IN (SELECT id FROM book WHERE original_only = 0)")
                let progressRecords: [BookProgressRecord]
                if let since = cutoff() {
                    progressRecords = try syncableProgress
                        .filter(Column("updated_at") >= since).fetchAll(db)
                } else {
                    progressRecords = try syncableProgress.fetchAll(db)
                }
                for record in progressRecords {
                    guard let model = try? record.domainModel(),
                        let data = try? encoder.encode(model)
                    else { continue }
                    payloads.append(
                        CloudPayload(
                            type: .bookProgress, id: record.bookId, data: data,
                            updatedAt: record.updatedAt))
                }
            }

            // 词包成员（仅 OpenKoto 云）。"未分组"是隐式的，不是真关系。
            if options.includeMemberships {
                var sql = "SELECT * FROM word_pack_membership WHERE pack_id != ?"
                var arguments: StatementArguments = [uuidString(WordPack.systemUngroupedID)]
                if let since = cutoff() {
                    sql += " AND created_at >= ?"
                    arguments += [since]
                }
                for record in try WordPackMembershipRecord.fetchAll(
                    db, sql: sql, arguments: arguments)
                {
                    let body = MembershipPayload(
                        vocabularyId: record.vocabularyId, packId: record.packId)
                    guard let data = try? encoder.encode(body) else { continue }
                    payloads.append(
                        CloudPayload(
                            type: .wordPackMembership,
                            id: "\(record.vocabularyId)_\(record.packId)", data: data,
                            updatedAt: record.createdAt))
                }
            }

            return payloads
        }
    }

    /// 待推送的删除（来自墓碑表）。
    public func pendingCloudDeletions(since watermark: Date?) async throws -> [(
        type: CloudRecordType, id: String
    )] {
        try await pendingCloudDeletionRecords(since: watermark).map { ($0.type, $0.id) }
    }

    /// 同上，带删除时间（OpenKoto 云要用它合成墓碑的 HLC）。
    public func pendingCloudDeletionRecords(since watermark: Date?) async throws -> [(
        type: CloudRecordType, id: String, deletedAt: Date
    )] {
        let cutoff = watermark.map { $0.addingTimeInterval(-Self.watermarkOverlap) }
        return try await database.writer.read { db in
            let rows: [TombstoneRecord]
            if let cutoff {
                rows = try TombstoneRecord.filter(Column("deleted_at") >= cutoff).fetchAll(db)
            } else {
                rows = try TombstoneRecord.fetchAll(db)
            }
            return rows.compactMap { row -> (CloudRecordType, String, Date)? in
                guard let table = TombstoneTable(rawValue: row.tableName) else { return nil }
                let type: CloudRecordType
                switch table {
                case .favoriteVocabulary: type = .vocabulary
                case .wordPack: type = .wordPack
                case .wordPackMembership: type = .wordPackMembership
                case .article: type = .article
                case .book: type = .book
                case .media: type = .media
                case .bookMark: type = .bookMark
                }
                return (type, row.recordId, row.deletedAt)
            }
        }
    }

    // MARK: - 应用云端拉回来的变更

    /// 把云端记录合并进本地。返回实际写入的条数。
    ///
    /// 冲突规则与文件导入一致（`ImportRules`），**唯独复习状态不走 LWW** ——
    /// 见下面的 `recomputeCardStates`。
    @discardableResult
    public func applyCloudPayloads(_ payloads: [CloudPayload], now: Date = .now) async throws
        -> Int
    {
        let decoder = CloudRecord.decoder()
        // 被引用的先落地，尽量让同一批里的外键当场就能接上。
        let ordered = payloads.sorted { $0.type.mergeOrder < $1.type.mergeOrder }
        let (applied, dropped) = try await database.writer.write { db -> (Int, [String]) in
            var applied = 0
            var touchedVocabulary: Set<String> = []

            for payload in ordered {
                applied += Self.mergeIsolated(
                    payload, into: db, decoder: decoder, now: now,
                    touched: &touchedVocabulary)
            }

            // 停放的记录重放。**两轮**：一轮解开一层依赖（article 到了 → 章节归属能写了），
            // 第二轮兜底更深的一层（章节归属写上了 → 依赖它的也能写了）。
            // 不做无限轮：解不开的下次同步再来，打转比慢更糟。
            for _ in 0..<2 {
                let parked = try Self.parkedPayloads(db)
                guard !parked.isEmpty else { break }
                var progressed = false
                for row in parked {
                    guard let type = CloudRecordType(rawValue: row.recordType) else { continue }
                    let payload = CloudPayload(
                        type: type, id: row.recordId, data: row.payload, updatedAt: row.updatedAt)
                    var attempt = row
                    attempt.attempts += 1
                    try attempt.update(db)
                    let before = applied
                    applied += Self.mergeIsolated(
                        payload, into: db, decoder: decoder, now: now,
                        touched: &touchedVocabulary, isRetry: true)
                    if applied > before { progressed = true }
                }
                // 一轮下来一条都没解开，再来一轮也是一样的结果。
                if !progressed { break }
            }
            let dropped = try Self.prunePendingPayloads(db, now: now)

            // 复习状态用事件重放重算，**绝不接受云端的卡片快照**。
            try Self.recomputeCardStates(db, vocabularyIDs: touchedVocabulary)
            return (applied, dropped)
        }
        if !dropped.isEmpty {
            // 丢弃必须留痕。这一整轮同步 bug 的共同形状就是"静默地少了点东西"。
            Self.cloudLogger.notice(
                "dropped \(dropped.count, privacy: .public) stale pending payloads: \(dropped.prefix(5).joined(separator: ", "), privacy: .public)"
            )
        }
        return applied
    }

    /// 一条记录一个 savepoint，并按结果决定停放还是删掉停放行。返回是否真的写了（0/1）。
    ///
    /// **每条一个 savepoint。** 之前整批共用一个事务，任何一条撞上约束都会把**整批**
    /// 回滚 —— 而 CloudKit 那边的 change token 照样往前走，于是这批记录再也不会被下发。
    /// 实测就是这么丢的：一条生词的 `source_article_id` 指向本机没有的文章，
    /// 撞出 FOREIGN KEY (787)，同一批里几十条完好的生词跟着一起没了，App 还显示"同步成功"。
    private static func mergeIsolated(
        _ payload: CloudPayload, into db: Database, decoder: JSONDecoder, now: Date,
        touched touchedVocabulary: inout Set<String>, isRetry: Bool = false
    ) -> Int {
        var written = 0
        do {
            try db.inSavepoint {
                let outcome = try Self.merge(
                    payload, into: db, decoder: decoder, now: now, touched: &touchedVocabulary)
                switch outcome {
                case .applied:
                    written = 1
                    try Self.unpark(db, payload)
                case .skipped:
                    // 有明确结论（本地更新、墓碑命中、重复），不必再等。
                    try Self.unpark(db, payload)
                case .deferred:
                    // 依赖没到。重试时该行已经在表里，`park` 会保留 attempts 与 first_seen_at。
                    try Self.park(
                        db, type: payload.type, id: payload.id, payload: payload.data,
                        updatedAt: payload.updatedAt, now: now)
                }
                return .commit
            }
        } catch {
            // 撞上没预判到的约束（唯一索引之类）。只丢这一条，其余照常。
            // 重试来的就让它留在停放表里等下次，attempts 已经加过了。
            if !isRetry {
                try? db.inSavepoint {
                    try Self.park(
                        db, type: payload.type, id: payload.id, payload: payload.data,
                        updatedAt: payload.updatedAt, now: now)
                    return .commit
                }
            }
        }
        return written
    }

    private static func unpark(_ db: Database, _ payload: CloudPayload) throws {
        _ = try PendingCloudPayloadRecord.deleteOne(
            db, key: CloudRecord.recordName(payload.type, payload.id))
    }

    /// 合并一条记录的三种结局。
    ///
    /// `deferred` 与 `skipped` 的区别是**能不能等到**：依赖记录晚一批到达是常态，
    /// 那要等；本地更新 / 墓碑命中是终局，等下去毫无意义。
    enum MergeOutcome {
        case applied
        case skipped
        case deferred
    }

    /// 合并一条云端记录。
    ///
    /// 抛错交给外层的 savepoint 兜底 —— 但**能预判的都要在这里表态**：
    /// 靠回滚处理正常情况等于让本该合并的数据白白丢一次。
    private static func merge(
        _ payload: CloudPayload, into db: Database, decoder: JSONDecoder, now: Date,
        touched touchedVocabulary: inout Set<String>
    ) throws -> MergeOutcome {
        switch payload.type {
        case .vocabulary:
            guard let model = try? decoder.decode(FavoriteVocabulary.self, from: payload.data)
            else { return .skipped }
            let local = try FavoriteVocabularyRecord.fetchOne(db, key: payload.id)
            guard
                shouldWrite(
                    db, table: .favoriteVocabulary, id: payload.id,
                    localUpdatedAt: local?.updatedAt, incoming: model.updatedAt)
            else { return .skipped }
            var record = FavoriteVocabularyRecord(model, now: model.updatedAt)
            // `source_article_id` 是真外键（`ON DELETE SET NULL`）。来源文章还没到本机时
            // 硬写会撞约束，而这条生词本身完全没问题 —— 词、释义、FSRS 进度都在。
            // **这里刻意不停放**：词比链接重要得多，宁可断链也要让它当场进来。
            // 断链只是少一个"跳回原文"的入口，而 `source_article_title` 还在，
            // 界面上仍然看得出它是从哪篇来的。
            if let articleID = record.sourceArticleId,
                try ArticleRecord.fetchOne(db, key: articleID) == nil
            {
                record.sourceArticleId = nil
                record.sourceSegmentId = nil
            }
            try record.save(db)
            touchedVocabulary.insert(payload.id)
            return .applied

        case .wordPack:
            guard let model = try? decoder.decode(WordPack.self, from: payload.data),
                !model.isSystem
            else { return .skipped }
            let local = try WordPackRecord.fetchOne(db, key: payload.id)
            guard
                shouldWrite(
                    db, table: .wordPack, id: payload.id,
                    localUpdatedAt: local?.updatedAt, incoming: model.updatedAt)
            else { return .skipped }
            try WordPackRecord(model, now: model.updatedAt).save(db)
            return .applied

        case .article:
            guard let model = try? decoder.decode(Article.self, from: payload.data)
            else { return .skipped }
            // 文章永不覆盖：正文变了，本地按旧正文切出来的 segment 会全部错位。
            guard try ArticleRecord.fetchOne(db, key: payload.id) == nil,
                try !isTombstoned(db, .article, payload.id)
            else { return .skipped }
            // 同名同**空**正文的已经在本机了就别再收一份。
            //
            // **`content` 为空这个条件不能去掉。** 它精确命中内置示例文章
            // （正文在 segment 里、`content` 是空串，见 `SampleData`）——旧版本里
            // 示例 id 是每台设备各自随机生成的，不去重就每接一台设备多两篇。
            // 而书籍章节与视频文稿的 `content` 永远非空：把它们一起去重的话，
            // 两台设备各自导入过同一本书时对端的章节会被全滤掉，
            // `book_chapter` 行却还指着那些不存在的 article ——
            // 撞外键，书库里留下**一本零章节的书**。
            if model.content.isEmpty {
                guard
                    try ArticleRecord
                        .filter(Column("title") == model.title && Column("content") == "")
                        .fetchCount(db) == 0
                else { return .skipped }
            }
            try ArticleRecord(model, now: model.createdAt).insert(db)
            return .applied

        case .segment:
            guard let model = try? decoder.decode(ArticleSegment.self, from: payload.data)
            else { return .skipped }
            // 父文章还没到：等着。一本书的章节与句子必然跨批次到达。
            // 但**父文章有墓碑就是终局** —— 用户删过它，等下去只是白占 30 天停放期，
            // 中间每轮还重试一次。实测 Mac 上就攒了一批这样的行。
            guard try ArticleRecord.fetchOne(db, key: uuidString(model.articleId)) != nil
            else {
                return try isTombstoned(db, .article, uuidString(model.articleId))
                    ? .skipped : .deferred
            }
            let local = try SegmentRecord.fetchOne(db, key: payload.id)?.domainModel()
            switch ImportRules.decideSegment(local: local, incoming: model) {
            case .insert:
                try SegmentRecord(model, meta: nil, now: model.createdAt).insert(db)
                return .applied
            case .fillMissing:
                try SegmentRecord(model, meta: nil, now: now).update(db)
                return .applied
            case .skip:
                return .skipped
            }

        case .reviewEvent:
            guard let model = try? decoder.decode(ReviewEvent.self, from: payload.data)
            else { return .skipped }
            // append-only：id 撞了就是同一条（顺手补上本地还没有的 HLC）
            if try ReviewLogRecord.fetchOne(db, key: payload.id) != nil {
                if let hlc = payload.hlc {
                    try db.execute(
                        sql: "UPDATE review_log SET hlc = ? WHERE id = ? AND hlc IS NULL",
                        arguments: [hlc, payload.id])
                }
                return .skipped
            }
            var log = ReviewLogRecord(model)
            log.hlc = payload.hlc
            try log.insert(db)
            touchedVocabulary.insert(uuidString(model.vocabularyId))
            return .applied

        case .wordPackMembership:
            let parts = payload.id.split(separator: "_", maxSplits: 1)
            guard parts.count == 2 else { return .skipped }
            let (vocabId, packId) = (String(parts[0]), String(parts[1]))
            // 墓碑命中是**终局**，不能停放等着 —— 等下去等于慢慢复活一条用户删过的关系。
            guard try !isTombstoned(db, .wordPackMembership, payload.id) else { return .skipped }
            guard try FavoriteVocabularyRecord.fetchOne(db, key: vocabId) != nil,
                try WordPackRecord.fetchOne(db, key: packId) != nil
            else { return .deferred }
            let exists =
                try Bool.fetchOne(
                    db,
                    sql: """
                        SELECT EXISTS(SELECT 1 FROM word_pack_membership
                        WHERE vocabulary_id = ? AND pack_id = ?)
                        """,
                    arguments: [vocabId, packId]) ?? false
            guard !exists else { return .skipped }
            try WordPackMembershipRecord(
                vocabularyId: vocabId, packId: packId, createdAt: now
            ).insert(db)
            return .applied

        // MARK: 书籍与媒体（只有文本与元数据，文件不上云）

        case .book:
            guard let model = try? decoder.decode(Book.self, from: payload.data)
            else { return .skipped }
            guard try !isTombstoned(db, .book, payload.id) else { return .skipped }
            let local = try BookRecord.fetchOne(db, key: payload.id)
            // `dirName` 指向对端的沙盒目录、在本机不存在，但那无所谓 ——
            // `BookStorage.directory(for:)` 是按 `book.id` 拼路径的，`dirName` 不参与解析。
            // 文件不在时原生模式照常可读（正文在 article 行里），
            // 只有原版模式与封面不可用，`BookReaderView.canUseOriginalMode` 已经处理好了。
            // 用 `payload.updatedAt`（推送侧取的是行的 `updated_at`）而不是
            // `model.createdAt`：`Book` 领域模型里没有 updatedAt，拿 createdAt 比
            // 等于永远不更新 —— 重新转写、改默认模式这类变更就永远传不过去。
            guard
                shouldWrite(
                    db, table: .book, id: payload.id,
                    localUpdatedAt: local?.updatedAt, incoming: payload.updatedAt)
            else { return .skipped }
            try BookRecord(model, now: payload.updatedAt).save(db)
            return .applied

        case .bookChapter:
            guard let model = try? decoder.decode(BookChapter.self, from: payload.data)
            else { return .skipped }
            // 删过的书 / 章不再等（同 `.segment` 的理由）。
            guard try !isTombstoned(db, .book, uuidString(model.bookId)),
                try !isTombstoned(db, .article, uuidString(model.articleId))
            else { return .skipped }
            // 两个真外键（article + book）。任一没到就等着 —— 一本 100 章的书
            // 必然跨批次，这里跳过就是**永久**少几章。
            guard try ArticleRecord.fetchOne(db, key: uuidString(model.articleId)) != nil,
                try BookRecord.fetchOne(db, key: uuidString(model.bookId)) != nil
            else { return .deferred }
            guard try BookChapterRecord.fetchOne(db, key: uuidString(model.articleId)) == nil
            else { return .skipped }
            try BookChapterRecord(model).insert(db)
            return .applied

        case .bookMark:
            guard let model = try? decoder.decode(BookMark.self, from: payload.data)
            else { return .skipped }
            guard try !isTombstoned(db, .bookMark, payload.id) else { return .skipped }
            guard try BookRecord.fetchOne(db, key: uuidString(model.bookId)) != nil
            else { return .deferred }
            let local = try BookMarkRecord.fetchOne(db, key: payload.id)
            guard
                shouldWrite(
                    db, table: .bookMark, id: payload.id,
                    localUpdatedAt: local?.updatedAt, incoming: model.updatedAt)
            else { return .skipped }
            var record = BookMarkRecord(model, now: model.updatedAt)
            // `chapter_article_id` 是 `ON DELETE SET NULL` 的软引用。章节还没到时置空即可：
            // `chapterIndex` / `segmentOrder` / `selectedText` 都在，划线仍然能重锚。
            if let chapterID = record.chapterArticleId,
                try ArticleRecord.fetchOne(db, key: chapterID) == nil
            {
                record.chapterArticleId = nil
            }
            try record.save(db)
            return .applied

        case .media:
            guard let model = try? decoder.decode(Media.self, from: payload.data)
            else { return .skipped }
            guard try !isTombstoned(db, .media, payload.id) else { return .skipped }
            let local = try MediaRecord.fetchOne(db, key: payload.id)
            guard
                shouldWrite(
                    db, table: .media, id: payload.id,
                    localUpdatedAt: local?.updatedAt, incoming: payload.updatedAt)
            else { return .skipped }
            // `bookmarkData` 在推送侧就被剔除了（见 `pendingCloudPayloads`）。
            // 这里再兜一次：万一收到带 bookmark 的旧记录，那份 bookmark 在本机
            // 解析不出来，留着只会让 `mediaFileURL` 反复走 `refreshBookmark` 的死路。
            var record = MediaRecord(model, now: payload.updatedAt)
            record.bookmarkData = nil
            try record.save(db)
            return .applied

        case .mediaPart:
            guard let model = try? decoder.decode(MediaPart.self, from: payload.data)
            else { return .skipped }
            guard try !isTombstoned(db, .media, uuidString(model.mediaId)),
                try !isTombstoned(db, .article, uuidString(model.articleId))
            else { return .skipped }
            guard try ArticleRecord.fetchOne(db, key: uuidString(model.articleId)) != nil,
                try MediaRecord.fetchOne(db, key: uuidString(model.mediaId)) != nil
            else { return .deferred }
            guard try MediaPartRecord.fetchOne(db, key: uuidString(model.articleId)) == nil
            else { return .skipped }
            try MediaPartRecord(model).insert(db)
            return .applied

        case .bookProgress:
            guard let model = try? decoder.decode(BookProgress.self, from: payload.data)
            else { return .skipped }
            let bookID = uuidString(model.bookId)
            guard try !isTombstoned(db, .book, bookID) else { return .skipped }
            guard try BookRecord.fetchOne(db, key: bookID) != nil else { return .deferred }
            let local = try BookProgressRecord.fetchOne(db, key: bookID)
            // 纯 LWW：谁最后读谁说了算。相等时保留本地，免得两台来回顶。
            if let local, local.updatedAt >= model.updatedAt { return .skipped }
            var record = BookProgressRecord(model)
            // `chapter_article_id` 是 `ON DELETE SET NULL` 的软引用，章节没到就置空，
            // `chapterIndex` 仍然能把人带回正确的章。
            if let chapterID = record.chapterArticleId,
                try ArticleRecord.fetchOne(db, key: chapterID) == nil
            {
                record.chapterArticleId = nil
            }
            try record.save(db)
            return .applied
        }
    }

    /// 云端的删除：本地也删，并记墓碑（防止别的设备把它推回来）。
    public func applyCloudDeletions(
        _ deletions: [(type: CloudRecordType, id: String)], now: Date = .now
    ) async throws {
        try await database.writer.write { db in
            for deletion in deletions {
                // 与合并侧同样的隔离：一条删不掉不该把整批回滚，
                // 而云端的 change token 是不会为我们回退的。
                try? db.inSavepoint {
                    try Self.applyOneDeletion(db, deletion, now: now)
                    return .commit
                }
            }
        }
    }

    private static func applyOneDeletion(
        _ db: Database, _ deletion: (type: CloudRecordType, id: String), now: Date
    ) throws {
        switch deletion.type {
        case .vocabulary:
            _ = try FavoriteVocabularyRecord.deleteOne(db, key: deletion.id)
            try TombstoneRecord.mark(
                db, table: .favoriteVocabulary, recordID: deletion.id, at: now)
        case .wordPack:
            _ = try WordPackRecord.deleteOne(db, key: deletion.id)
            try TombstoneRecord.mark(
                db, table: .wordPack, recordID: deletion.id, at: now)
        case .article:
            _ = try ArticleRecord.deleteOne(db, key: deletion.id)
            try TombstoneRecord.mark(db, table: .article, recordID: deletion.id, at: now)
        case .wordPackMembership:
            let parts = deletion.id.split(separator: "_", maxSplits: 1)
            guard parts.count == 2 else { return }
            try db.execute(
                sql:
                    "DELETE FROM word_pack_membership WHERE vocabulary_id = ? AND pack_id = ?",
                arguments: [String(parts[0]), String(parts[1])])
            try TombstoneRecord.mark(
                db, table: .wordPackMembership, recordID: deletion.id, at: now)
        case .book:
            // **必须复刻 `BookRepository.deleteBook` 的顺序**：
            // 先删章节 article（触发 segment 级联删除、收藏 source_article_id 置空），
            // 再删 book（级联清掉 book_chapter / book_progress / book_mark）。
            // 反过来的话 book 一删，book_chapter 先没了，章节 article 就再也找不到，
            // 变成一堆孤儿文章挂在书库列表里。
            try Self.deleteBookCascade(db, bookID: deletion.id, now: now)
            try TombstoneRecord.mark(db, table: .book, recordID: deletion.id, at: now)
        case .media:
            try Self.deleteMediaCascade(db, mediaID: deletion.id, now: now)
            try TombstoneRecord.mark(db, table: .media, recordID: deletion.id, at: now)
        case .bookMark:
            _ = try BookMarkRecord.deleteOne(db, key: deletion.id)
            try TombstoneRecord.mark(db, table: .bookMark, recordID: deletion.id, at: now)
        case .bookProgress:
            // 进度没有独立墓碑；书删了它随 FK 级联。收到了也照删不误。
            _ = try BookProgressRecord.deleteOne(db, key: deletion.id)
        case .segment, .reviewEvent, .bookChapter, .mediaPart:
            // 段落与归属行随父级联；复习事件只增不删。都不会收到独立的删除。
            break
        }
    }

    // MARK: - 书 / 媒体的级联删除

    /// 与 `BookRepository.deleteBook` 同一套顺序，外加为每一章的 article 记墓碑
    /// —— 否则别的设备会把那些章节文章再推回来。
    static func deleteBookCascade(_ db: Database, bookID: String, now: Date) throws {
        let chapterIDs = try String.fetchAll(
            db, sql: "SELECT article_id FROM book_chapter WHERE book_id = ?",
            arguments: [bookID])
        for articleID in chapterIDs {
            _ = try ArticleRecord.deleteOne(db, key: articleID)
            try TombstoneRecord.mark(db, table: .article, recordID: articleID, at: now)
        }
        _ = try BookRecord.deleteOne(db, key: bookID)
    }

    static func deleteMediaCascade(_ db: Database, mediaID: String, now: Date) throws {
        let articleIDs = try String.fetchAll(
            db, sql: "SELECT article_id FROM media_part WHERE media_id = ?",
            arguments: [mediaID])
        for articleID in articleIDs {
            _ = try ArticleRecord.deleteOne(db, key: articleID)
            try TombstoneRecord.mark(db, table: .article, recordID: articleID, at: now)
        }
        _ = try MediaRecord.deleteOne(db, key: mediaID)
    }

    // MARK: - 冲突判定

    private static func isTombstoned(
        _ db: Database, _ table: TombstoneTable, _ id: String
    ) throws -> Bool {
        try Bool.fetchOne(
            db,
            sql: "SELECT EXISTS(SELECT 1 FROM deleted_record WHERE table_name = ? AND record_id = ?)",
            arguments: [table.rawValue, id]) ?? false
    }

    private static func shouldWrite(
        _ db: Database, table: TombstoneTable, id: String,
        localUpdatedAt: Date?, incoming: Date
    ) -> Bool {
        guard (try? isTombstoned(db, table, id)) == false else { return false }
        switch ImportRules.decide(
            isTombstoned: false, localUpdatedAt: localUpdatedAt, incomingUpdatedAt: incoming)
        {
        case .insert, .update: return true
        case .skipDeleted, .skipLocalNewer: return false
        }
    }

    /// 用复习事件重放，重算这些卡片的 FSRS 状态。
    ///
    /// **这是同步里唯一不能用 last-writer-wins 的地方。** 两台设备各离线复习一轮，
    /// 若按快照后写胜，晚同步的那台会整轮覆盖掉另一台——用户复习了两次、
    /// 进度只记了一次，而且毫无提示。事件表只增不删，重放出来的状态与
    /// "在同一台设备上依次复习两次"完全一致。
    /// 旧事件没记 `desiredRetention` 时的退路：本机设置（与实时复习同一个键）。
    static var desiredRetentionFallback: Double {
        let value = UserDefaults.standard.double(forKey: "srs.desiredRetention")
        return value > 0 && value <= 1 ? value : FSRS.defaultDesiredRetention
    }

    /// 上传成功的复习事件记下它在云上的 HLC（重放排序要用，各端必须一致）。
    public func setReviewEventHLCs(_ hlcs: [String: String]) async throws {
        guard !hlcs.isEmpty else { return }
        try await database.writer.write { db in
            for (id, hlc) in hlcs {
                try db.execute(
                    sql: "UPDATE review_log SET hlc = ? WHERE id = ? AND hlc IS NULL",
                    arguments: [hlc, id])
            }
        }
    }

    static func recomputeCardStates(_ db: Database, vocabularyIDs: Set<String>) throws {
        for vocabId in vocabularyIDs {
            guard var record = try FavoriteVocabularyRecord.fetchOne(db, key: vocabId) else {
                continue
            }
            let rows = try ReviewLogRecord
                .filter(Column("vocabulary_id") == vocabId)
                .order(Column("reviewed_at"))
                .fetchAll(db)
            var hlcs: [UUID: String] = [:]
            let events = rows.compactMap { row -> ReviewEvent? in
                guard let event = try? row.domainModel() else { return nil }
                if let hlc = row.hlc { hlcs[event.id] = hlc }
                return event
            }
            // 撤销标记与被作废的事件都不参与（同步协议 §6），排序用 (reviewedAt, hlc, id)。
            guard
                let state = ReviewReplay.replay(
                    events, desiredRetention: desiredRetentionFallback, hlcs: hlcs)
            else {
                // 有事件、却一条有效的都没有：全被撤销了，卡片回到"未学"。
                // 没有任何撤销标记的（空事件 / 全是非法评分）保持原状。
                if events.contains(where: { $0.voidsEventId != nil }) {
                    record.srsState = SRSState.new.rawValue
                    record.stability = 0
                    record.difficulty = 0
                    record.dueDate = FSRS.localDateString(record.createdAt)
                    record.lastReviewedAt = nil
                    record.reviewCount = 0
                    try record.update(db)
                }
                continue
            }
            record.srsState = state.srsState.rawValue
            record.stability = state.stability
            record.difficulty = state.difficulty
            record.dueDate = state.dueDate
            record.lastReviewedAt = state.lastReviewedAt
            record.reviewCount = state.reviewCount
            record.schedulerVersion = state.schedulerVersion
            try record.update(db)
        }
    }
}
