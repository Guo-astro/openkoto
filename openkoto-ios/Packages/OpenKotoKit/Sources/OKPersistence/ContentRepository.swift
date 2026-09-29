import Foundation
import GRDB
import OKModels

/// 内容仓库：文章 / 逐句 / 生词收藏的单一读写入口（设计文档 §3.2）。
/// 每个写方法都是一个事务；调用方（ContentStore）负责串行化提交顺序。
public struct ContentRepository: Sendable {
    /// 某篇/某章的句子统计。启动只查计数不读正文——一本 50 万字小说约 1.5 万句，
    /// 全量载入内存是撑不住的。
    public struct SegmentCounts: Sendable, Equatable {
        public var total: Int
        public var explained: Int

        public init(total: Int = 0, explained: Int = 0) {
            self.total = total
            self.explained = explained
        }
    }

    public struct LibrarySnapshot: Sendable {
        /// 只含顶层文章：书籍章节虽然也是 article 行，但不该出现在书库列表里。
        public var articles: [Article]
        /// 全部 article（含章节）的句子计数，供进度徽章使用。
        public var segmentCounts: [UUID: SegmentCounts]
        public var favorites: [FavoriteVocabulary]
        public var packs: [WordPack]

        public init(
            articles: [Article] = [],
            segmentCounts: [UUID: SegmentCounts] = [:],
            favorites: [FavoriteVocabulary] = [],
            packs: [WordPack] = []
        ) {
            self.articles = articles
            self.segmentCounts = segmentCounts
            self.favorites = favorites
            self.packs = packs
        }
    }

    // internal 而非 private：同模块的 TransferIO / 同步引擎以 extension 形式扩展本类型，
    // 需要拿到同一个 writer 才能把整批导入放进单一事务。
    let database: AppDatabase

    public init(database: AppDatabase) {
        self.database = database
    }

    // MARK: - 读

    /// 启动加载：文章元数据 + 生词 + 词包，**不含任何句子**。
    ///
    /// 句子改为逐篇按需加载（`loadSegments`）——书籍章节动辄上万句，
    /// 预加载会让启动内存与耗时随书库线性膨胀；普通文章同样受益。
    /// 进度徽章所需的计数走两条 index-only 聚合查询，不触碰正文页。
    public func loadAll() async throws -> LibrarySnapshot {
        try await database.writer.read { db in
            // 书籍章节与媒体文稿也是 article 行，但各归 book / media 管，
            // 在书库顶层列表里以书/视频卡片出现，不重复成一条文章。
            let articles = try ArticleRecord
                .filter(
                    sql: """
                        id NOT IN (SELECT article_id FROM book_chapter)
                        AND id NOT IN (SELECT article_id FROM media_part)
                        """)
                .order(Column("created_at").desc, Column("id"))
                .fetchAll(db)
                .map { try $0.domainModel() }
            let favorites = try Self.fetchFavorites(db)
            let packs = try WordPackRecord
                .order(Column("created_at"))
                .fetchAll(db)
                .map { try $0.domainModel() }
            return LibrarySnapshot(
                articles: articles,
                segmentCounts: try Self.fetchSegmentCounts(db),
                favorites: favorites,
                packs: packs
            )
        }
    }

    /// 逐篇/逐章的句子计数。两条聚合都只扫索引：
    /// 总数走 v1 建的 `segment(article_id)`，已精讲数走 v3 建的部分索引。
    static func fetchSegmentCounts(_ db: Database) throws -> [UUID: SegmentCounts] {
        var counts: [UUID: SegmentCounts] = [:]
        for row in try Row.fetchAll(
            db, sql: "SELECT article_id, COUNT(*) AS n FROM segment GROUP BY article_id")
        {
            let id = try parseUUID(row["article_id"], table: "segment")
            counts[id, default: SegmentCounts()].total = row["n"]
        }
        for row in try Row.fetchAll(
            db,
            sql: """
                SELECT article_id, COUNT(*) AS n FROM segment
                WHERE explanation_json IS NOT NULL GROUP BY article_id
                """)
        {
            let id = try parseUUID(row["article_id"], table: "segment")
            counts[id, default: SegmentCounts()].explained = row["n"]
        }
        return counts
    }

    /// 打开某篇/某章时才载入它的句子。
    public func loadSegments(articleID: UUID) async throws -> [ArticleSegment] {
        try await database.writer.read { db in
            try SegmentRecord
                .filter(Column("article_id") == uuidString(articleID))
                .order(Column("order_index"))
                .fetchAll(db)
                .map { try $0.domainModel() }
        }
    }

    /// 取单独一句——生词卡的「出处」弹窗用。
    ///
    /// 连译文和精讲一起带回来：出处弹窗要在不进阅读器的前提下把这一句讲清楚，
    /// 而这些都已经躺在同一行里了，分两次查没有意义。
    ///
    /// 刻意**不走 `loadSegments`**：那会把整章上万句读进来，还会挤掉
    /// `ContentStore` 里正在读的那几章（LRU 只留 3 篇）。复习二十张卡就能把
    /// 用户翻到一半的章节反复顶出内存。这里只取一行，不碰任何缓存。
    public func segment(id: UUID) async throws -> ArticleSegment? {
        try await database.writer.read { db in
            try SegmentRecord
                .filter(Column("id") == uuidString(id))
                .fetchOne(db)?
                .domainModel()
        }
    }

    /// 出处回填：在指定文章里找含该词的句子（按句序，取前若干条候选）。
    ///
    /// 给的是**候选**不是答案——同一个词在一篇里出现多次时，调用方还要用精讲词汇表
    /// 再筛一道（见 `ContentStore+Source`）。`source_segment_id` 是 v5 才加的列且没有回填，
    /// 升级前收藏的卡全都指不到句子，这条查询就是把它们捞回来的唯一手段。
    ///
    /// 同样**不走 `loadSegments`**（理由见 `segment(id:)`），并且 `limit` 封顶。
    /// 用 `instr(lower(...))` 而不是 `LIKE`：不必转义 `%` `_`，且对 ASCII 大小写不敏感
    /// （句首大写的英文词也能命中；CJK 不受 `lower()` 影响）。
    public func segments(
        articleID: UUID, containing word: String, limit: Int = 8
    ) async throws -> [ArticleSegment] {
        let needle = word.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return [] }
        return try await database.writer.read { db in
            try SegmentRecord
                .filter(
                    sql: "article_id = ? AND instr(lower(text), lower(?)) > 0",
                    arguments: [uuidString(articleID), needle])
                .order(Column("order_index"))
                .limit(max(limit, 0))
                .fetchAll(db)
                .map { try $0.domainModel() }
        }
    }

    /// 只写 `source_segment_id`（照 `setSuspended` 的写法，不整行覆盖）——
    /// 回填是后台自愈动作，不该把用户可能正在编辑的释义一起盖掉。
    public func setSourceSegment(
        vocabularyId: UUID, segmentId: UUID, now: Date = .now
    ) async throws {
        try await database.writer.write { db in
            try db.execute(
                sql: """
                    UPDATE favorite_vocabulary
                    SET source_segment_id = :segment, updated_at = :now
                    WHERE id = :id
                    """,
                arguments: [
                    "segment": uuidString(segmentId),
                    "now": now,
                    "id": uuidString(vocabularyId),
                ])
        }
    }

    /// 延迟切分后写入：同一事务里删旧句、插新句、标记该章已切分。
    /// 旧句一并删除是为了让重切分幂等（首开时若中途失败，重来一次即可）。
    public func replaceSegments(
        articleID: UUID, segments: [ArticleSegment], now: Date = .now
    ) async throws {
        try await database.writer.write { db in
            try db.execute(
                sql: "DELETE FROM segment WHERE article_id = ?",
                arguments: [uuidString(articleID)])
            for segment in segments {
                try SegmentRecord(segment, meta: nil, now: now).insert(db)
            }
            try db.execute(
                sql: "UPDATE book_chapter SET is_segmented = 1 WHERE article_id = ?",
                arguments: [uuidString(articleID)])
        }
    }

    /// 读取全部生词(含词包成员),按 created_at 降序。
    static func fetchFavorites(_ db: Database) throws -> [FavoriteVocabulary] {
        var packIdsByVocabulary: [String: [UUID]] = [:]
        for membership in try WordPackMembershipRecord.fetchAll(db) {
            let packId = try parseUUID(membership.packId, table: "word_pack_membership")
            packIdsByVocabulary[membership.vocabularyId, default: []].append(packId)
        }
        return try FavoriteVocabularyRecord
            .order(Column("created_at").desc)
            .fetchAll(db)
            .map { try $0.domainModel(packIds: packIdsByVocabulary[$0.id] ?? []) }
    }

    // MARK: - 文章

    /// 导入：文章 + 全部切分句在同一事务写入（任一失败整体回滚）。
    public func insertArticle(
        _ article: Article, segments: [ArticleSegment], now: Date = .now
    ) async throws {
        try await database.writer.write { db in
            try ArticleRecord(article, now: now).insert(db)
            for segment in segments {
                try SegmentRecord(segment, meta: nil, now: now).insert(db)
            }
        }
    }

    /// 取单篇文章（延迟切分时要读章节正文）。
    public func article(id: UUID) async throws -> Article? {
        try await database.writer.read { db in
            try ArticleRecord.fetchOne(db, key: uuidString(id))?.domainModel()
        }
    }

    /// 删除文章；segment 级联删除、收藏 source_article_id 置空由 FK 完成。
    ///
    /// segment 不单独记墓碑：它们是文章的子行，导入方按"文章被删过"整体跳过即可。
    public func deleteArticle(id: UUID, now: Date = .now) async throws {
        _ = try await database.writer.write { db in
            try ArticleRecord.deleteOne(db, key: uuidString(id))
            try TombstoneRecord.mark(db, table: .article, id: id, at: now)
        }
    }

    // MARK: - 精讲回填

    /// 只在该句尚未精讲时写入（不覆盖已有结果，对齐内存层写回校验）。
    /// - Returns: 是否实际写入（句子已删除或已精讲时为 false）。
    @discardableResult
    public func saveExplanation(
        segmentID: UUID,
        explanation: SegmentExplanation,
        meta: ExplanationMeta?,
        now: Date = .now
    ) async throws -> Bool {
        let envelope = ExplanationEnvelope(explanation: explanation, meta: meta)
        let json = String(decoding: try WireJSON.encoder.encode(envelope), as: UTF8.self)
        return try await database.writer.write { db in
            try db.execute(
                sql: """
                    UPDATE segment
                    SET explanation_json = :json,
                        translation = :translation,
                        reading_text = COALESCE(:reading, reading_text),
                        updated_at = :now
                    WHERE id = :id AND explanation_json IS NULL
                    """,
                arguments: [
                    "json": json,
                    "translation": explanation.translation,
                    "reading": explanation.readingText,
                    "now": now,
                    "id": uuidString(segmentID),
                ])
            return db.changesCount > 0
        }
    }

    // MARK: - 全库搜索

    /// 一条搜索结果：命中的容器 + 带高亮标记的片段。
    public struct SearchHit: Sendable, Equatable, Identifiable {
        public var articleID: UUID
        public var title: String
        /// 命中处的上下文，命中词用 `\u{2}`…`\u{3}` 包起来（不可见控制符，
        /// 避免与正文里可能出现的任何标记冲突，由 UI 转成高亮）。
        public var snippet: String
        public var id: UUID { articleID }

        public static let highlightStart = "\u{2}"
        public static let highlightEnd = "\u{3}"
    }

    /// trigram 的硬约束：查询串短于这个长度就查不出任何东西。
    public static let minimumFTSQueryLength = 3

    /// 全库搜索。
    ///
    /// **两条路**：≥3 字符走 FTS5（trigram，有 snippet 与 bm25 排序）；
    /// 更短的走 LIKE 全表扫。后者是必需的——中文两字词（"日本""文法"）是最高频查询，
    /// 而 trigram 根本查不到它们。书库是"几十本"量级不是"几十万文档"，加了 LIMIT
    /// 之后全表扫的代价可以接受，比为此上自定义 tokenizer 便宜两个数量级。
    public func search(_ rawQuery: String, limit: Int = 50) async throws -> [SearchHit] {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }
        return query.unicodeScalars.count >= Self.minimumFTSQueryLength
            ? try await ftsSearch(query, limit: limit)
            : try await likeSearch(query, limit: limit)
    }

    private func ftsSearch(_ query: String, limit: Int) async throws -> [SearchHit] {
        try await database.writer.read { db in
            // 用短语匹配：trigram 上前缀查询（`词*`）永远返回空，别用 GRDB 的
            // `matchingAllPrefixesIn`。整串当一个短语查才是 trigram 的正确用法。
            let pattern = FTS5Pattern(matchingPhrase: query)
            guard let pattern else { return [] }
            let rows = try Row.fetchAll(
                db,
                sql: """
                    SELECT a.id AS id, a.title AS title,
                           snippet(article_fts, 1, ?, ?, '…', 12) AS snip
                    FROM article_fts
                    JOIN article a ON a.rowid = article_fts.rowid
                    WHERE article_fts MATCH ?
                    ORDER BY bm25(article_fts)
                    LIMIT ?
                    """,
                arguments: [
                    SearchHit.highlightStart, SearchHit.highlightEnd, pattern, limit,
                ])
            return try rows.map { row in
                SearchHit(
                    articleID: try parseUUID(row["id"], table: "article"),
                    title: row["title"],
                    snippet: row["snip"] ?? "")
            }
        }
    }

    /// 两字查询的兜底。没有 snippet，自己截一段上下文出来。
    private func likeSearch(_ query: String, limit: Int) async throws -> [SearchHit] {
        try await database.writer.read { db in
            let rows = try Row.fetchAll(
                db,
                sql: """
                    SELECT id, title, content FROM article
                    WHERE content LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
                    LIMIT ?
                    """,
                arguments: ["%\(escapeLike(query))%", "%\(escapeLike(query))%", limit])
            return try rows.map { row in
                SearchHit(
                    articleID: try parseUUID(row["id"], table: "article"),
                    title: row["title"],
                    snippet: Self.excerpt(from: row["content"] ?? "", around: query))
            }
        }
    }

    /// 在正文里截出命中处前后各若干字，并打上高亮标记。
    static func excerpt(from content: String, around query: String, radius: Int = 24) -> String {
        guard let range = content.range(of: query) else {
            return String(content.prefix(radius * 2))
        }
        let scalars = Array(content.unicodeScalars)
        let hitStart = content.unicodeScalars.distance(
            from: content.unicodeScalars.startIndex, to: range.lowerBound)
        let hitEnd = content.unicodeScalars.distance(
            from: content.unicodeScalars.startIndex, to: range.upperBound)
        let from = max(0, hitStart - radius)
        let to = min(scalars.count, hitEnd + radius)

        func text(_ r: Range<Int>) -> String {
            var view = String.UnicodeScalarView()
            view.append(contentsOf: scalars[r])
            return String(view)
        }
        let prefix = from > 0 ? "…" : ""
        let suffix = to < scalars.count ? "…" : ""
        return prefix + text(from..<hitStart) + SearchHit.highlightStart
            + text(hitStart..<hitEnd) + SearchHit.highlightEnd + text(hitEnd..<to) + suffix
    }

    private func escapeLike(_ text: String) -> String {
        text.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "%", with: "\\%")
            .replacingOccurrences(of: "_", with: "\\_")
    }

    /// 还有多少篇没进索引（UI 用它显示"正在建立索引"）。
    public func pendingIndexCount() async throws -> Int {
        try await database.writer.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM fts_backfill") ?? 0
        }
    }

    /// 库里有没有同一句原文已经精讲过的结果——有就不必再向 AI 付一次钱。
    ///
    /// 命中的主场景不是"同一句出现在两篇文章里"，而是：
    /// 同一本书重新导入（切分后 segment 全换新 UUID，精讲全丢）、同一篇文章被分享两次、
    /// 视频字幕与它的文稿章节重叠。
    ///
    /// 走 `segment_on_source_hash` 部分索引（v5 的虚拟生成列，实测查询计划确实用它）。
    /// `promptVersion` 用**兼容集合**判而不是等值——将来 prompt 改版时，
    /// 旧结果只要语义仍兼容就该继续可用，不该一改版全部作废。
    public func existingExplanation(
        sourceTextHash: String, targetLanguage: String, compatiblePromptVersions: Set<String>
    ) async throws -> ExplanationEnvelope? {
        try await database.writer.read { db in
            let rows = try String.fetchAll(
                db,
                sql: """
                    SELECT explanation_json FROM segment
                    WHERE source_text_hash = ? AND explanation_json IS NOT NULL
                    LIMIT 8
                    """,
                arguments: [sourceTextHash])
            for json in rows {
                guard
                    let envelope = try? WireJSON.decoder.decode(
                        ExplanationEnvelope.self, from: Data(json.utf8))
                else { continue }
                // 目标语言必须一致：讲解语言不同的结果对用户毫无意义
                guard envelope.targetLanguage == targetLanguage else { continue }
                guard let version = envelope.promptVersion,
                    compatiblePromptVersions.contains(version)
                else { continue }
                return envelope
            }
            return nil
        }
    }

    /// 只写译文（快翻/全文翻译），不写 explanation_json；已精讲的句子不覆盖。
    /// - Returns: 是否实际写入。
    @discardableResult
    public func saveTranslation(
        segmentID: UUID, translation: String, now: Date = .now
    ) async throws -> Bool {
        try await database.writer.write { db in
            try db.execute(
                sql: """
                    UPDATE segment
                    SET translation = :translation, updated_at = :now
                    WHERE id = :id AND explanation_json IS NULL
                    """,
                arguments: ["translation": translation, "now": now, "id": uuidString(segmentID)])
            return db.changesCount > 0
        }
    }

    // MARK: - 查词缓存

    /// 读一个词的缓存释义。返回 nil 表示没查过；context 是否过期由调用方比对。
    public func fetchWordGloss(normalizedWord: String) async throws -> WordGlossHit? {
        try await database.writer.read { db in
            try WordGlossRecord
                .filter(Column("normalized_word") == normalizedWord)
                .fetchOne(db)
        }
        .map { WordGlossHit(item: $0.domainModel(), context: $0.context) }
    }

    /// 写入/覆盖一个词的缓存释义。同一个词只留最新一次查询结果。
    public func upsertWordGloss(_ item: VocabularyItem, context: String, now: Date = .now) async throws {
        let record = WordGlossRecord(item, context: context, now: now)
        try await database.writer.write { db in
            try record.save(db)
        }
    }

    /// 查词缓存命中。`context` 供调用方做失效比对（prompt 版本 + 模型 + 目标语言）。
    public struct WordGlossHit: Sendable, Equatable {
        public var item: VocabularyItem
        public var context: String
    }

    // MARK: - 生词收藏

    /// 违反去重约束（normalized_word + source_article_id）时抛错，由调用方先查重。
    /// 卡片与词包成员在同一事务写入。
    public func insertFavorite(_ favorite: FavoriteVocabulary, now: Date = .now) async throws {
        let record = FavoriteVocabularyRecord(favorite, now: now)
        let memberships = favorite.packIds.map {
            WordPackMembershipRecord(
                vocabularyId: record.id, packId: uuidString($0), createdAt: now)
        }
        try await database.writer.write { db in
            try record.insert(db)
            for membership in memberships {
                try membership.insert(db)
            }
        }
    }

    /// 更新卡片(编辑词形/释义等;词形变化时 normalized_word 由 Record 重新计算)。
    /// 词包成员不在此处变更——用 `setPackIds`。
    public func updateFavorite(_ favorite: FavoriteVocabulary, now: Date = .now) async throws {
        let record = FavoriteVocabularyRecord(favorite, now: now)
        try await database.writer.write { db in
            try record.update(db)
        }
    }

    /// 标记已掌握/恢复复习(规范 §3):只写 suspended_at,FSRS 状态不动。
    public func setSuspended(id: UUID, suspended: Bool, now: Date = .now) async throws {
        try await database.writer.write { db in
            try db.execute(
                sql: """
                    UPDATE favorite_vocabulary
                    SET suspended_at = :suspended, updated_at = :now
                    WHERE id = :id
                    """,
                arguments: [
                    "suspended": suspended ? now : nil,
                    "now": now,
                    "id": uuidString(id),
                ])
        }
    }

    /// 词包成员整体替换(diff 写 membership 表)。
    public func setPackIds(vocabularyId: UUID, packIds: [UUID], now: Date = .now) async throws {
        let vocabId = uuidString(vocabularyId)
        let target = Set(packIds.map(uuidString))
        try await database.writer.write { db in
            let existing = Set(
                try WordPackMembershipRecord
                    .filter(Column("vocabulary_id") == vocabId)
                    .fetchAll(db)
                    .map(\.packId))
            for removed in existing.subtracting(target) {
                try db.execute(
                    sql: "DELETE FROM word_pack_membership WHERE vocabulary_id = ? AND pack_id = ?",
                    arguments: [vocabId, removed])
                // 「把这个词移出这个词包」是一次独立的删除意图，生词和词包都还活着，
                // 所以必须单独记墓碑——否则下次导入会把它塞回原来的包里。
                try TombstoneRecord.mark(
                    db, table: .wordPackMembership,
                    recordID: "\(vocabId)_\(removed)", at: now)
            }
            for added in target.subtracting(existing) {
                try WordPackMembershipRecord(
                    vocabularyId: vocabId, packId: added, createdAt: now
                ).insert(db)
            }
        }
    }

    /// 删除生词。
    ///
    /// 它的 membership 由 FK 级联清除，**不逐条记墓碑**：导入方看到生词本身
    /// 被删过就会跳过，连带它的所有关系一起跳，逐条记只会白白放大墓碑表。
    public func deleteFavorite(id: UUID, now: Date = .now) async throws {
        _ = try await database.writer.write { db in
            try FavoriteVocabularyRecord.deleteOne(db, key: uuidString(id))
            try TombstoneRecord.mark(db, table: .favoriteVocabulary, id: id, at: now)
        }
    }

    // MARK: - 复习(FSRS 更新由调用方经 OKSRS 计算;仓库只负责事务落盘)

    /// 复习落盘:同一事务内更新卡片 + 追加一条不可变复习事件(规范 §1.3)。
    public func applyReview(
        _ favorite: FavoriteVocabulary, event: ReviewEvent, now: Date = .now
    ) async throws {
        let record = FavoriteVocabularyRecord(favorite, now: now)
        let logRecord = ReviewLogRecord(event)
        try await database.writer.write { db in
            try record.update(db)
            try logRecord.insert(db)
        }
    }

    // MARK: - 阅读会话(统计用；append-only)

    public func recordReadingSession(_ session: ReadingSession) async throws {
        let record = ReadingSessionRecord(session)
        try await database.writer.write { db in
            try record.insert(db)
        }
    }

    #if DEBUG
    /// 截图/QA 用(-seedStatsDemo)：一次性写入合成生词 + 复习日志 + 阅读会话。仅 DEBUG。
    public func seedDemo(
        favorites: [FavoriteVocabulary],
        events: [ReviewEvent],
        sessions: [ReadingSession],
        now: Date = .now
    ) async throws {
        try await database.writer.write { db in
            for favorite in favorites {
                try FavoriteVocabularyRecord(favorite, now: now).insert(db)
            }
            for event in events {
                try ReviewLogRecord(event).insert(db)
            }
            for session in sessions {
                try ReadingSessionRecord(session).insert(db)
            }
        }
    }
    #endif

    /// 今日到期队列(规范 §3,镜像桌面 build_due_vocabulary_queue):
    /// 排除 suspended → 词包过滤 → due_date <= 今日(坏日期视为到期)
    /// → new/learning 优先于 review → 各按 (due_date, last_reviewed_at) 升序 → 每日上限截断。
    public func dueQueue(
        packId: UUID?, dateLocal: String, newLimit: Int, reviewLimit: Int
    ) async throws -> [FavoriteVocabulary] {
        let favorites = try await database.writer.read { db in
            try Self.fetchFavorites(db)
        }
        var candidates = favorites.filter { $0.suspendedAt == nil }
        if let packId {
            candidates = candidates.filter { $0.packIds.contains(packId) }
        }
        candidates = candidates.filter { Self.isDueOnOrBefore($0.dueDate, target: dateLocal) }

        var newLearning = candidates.filter { $0.srsState == .new || $0.srsState == .learning }
        var review = candidates.filter { $0.srsState == .review }
        newLearning.sort(by: Self.dueThenLastReview)
        review.sort(by: Self.dueThenLastReview)

        // 每日上限**只截新词**：learning 是"今天已经开了头、还没答对"的卡,
        // 被 20 张新材料挤出队列就等于当天再也见不到,同日巩固步骤(§2.8)就白做了。
        var newTaken = 0
        newLearning = newLearning.filter { card in
            guard card.srsState == .new else { return true }
            newTaken += 1
            return newTaken <= max(newLimit, 0)
        }

        return newLearning + Array(review.prefix(max(reviewLimit, 0)))
    }

    /// 今日队列清空后的「提前复习」：取最近要到期的若干张。
    ///
    /// 与 `dueQueue` 互补——只收 `due_date` **严格晚于**今天的卡，两者永不重叠。
    /// 评分照常走 FSRS：提前复习意味着 elapsed 小于计划值，长期模式本就正确处理这种情况。
    public func aheadQueue(
        packId: UUID?, dateLocal: String, limit: Int
    ) async throws -> [FavoriteVocabulary] {
        let favorites = try await database.writer.read { db in
            try Self.fetchFavorites(db)
        }
        var candidates = favorites.filter { $0.suspendedAt == nil }
        if let packId {
            candidates = candidates.filter { $0.packIds.contains(packId) }
        }
        // 坏日期在 dueQueue 里视为"已到期"，这里就必须排除，否则两个队列会重复给同一张卡。
        candidates = candidates.filter { !Self.isDueOnOrBefore($0.dueDate, target: dateLocal) }
        candidates.sort(by: Self.dueThenLastReview)
        return Array(candidates.prefix(max(limit, 0)))
    }

    /// 与桌面 is_due_on_or_before 一致:无法解析的 due_date 视为到期。
    static func isDueOnOrBefore(_ dueDate: String, target: String) -> Bool {
        guard isValidLocalDate(dueDate) else { return true }
        return dueDate <= target
    }

    static func isValidLocalDate(_ value: String) -> Bool {
        guard value.count == 10 else { return false }
        var components = DateComponents()
        let parts = value.split(separator: "-")
        guard parts.count == 3,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2])
        else { return false }
        components.year = year
        components.month = month
        components.day = day
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return components.isValidDate(in: calendar)
    }

    /// 与桌面 sort_by_due_then_last_review 一致(nil 的 last_reviewed_at 排前)。
    static func dueThenLastReview(_ a: FavoriteVocabulary, _ b: FavoriteVocabulary) -> Bool {
        if a.dueDate != b.dueDate { return a.dueDate < b.dueDate }
        switch (a.lastReviewedAt, b.lastReviewedAt) {
        case (nil, nil): return false
        case (nil, _): return true
        case (_, nil): return false
        case let (lhs?, rhs?): return lhs < rhs
        }
    }

    // MARK: - 统计(规范 §6)

    public func reviewStats(packId: UUID?, dateLocal: String) async throws -> ReviewStats {
        let (favorites, events) = try await database.writer.read { db in
            (
                try Self.fetchFavorites(db),
                try ReviewLogRecord.fetchAll(db).map { try $0.domainModel() }
            )
        }
        return Self.buildReviewStats(
            favorites: favorites, events: events, packId: packId, dateLocal: dateLocal)
    }

    /// 「通过」的评分下限(good = 3;规范 §2.5 的档位编号)。
    /// OKPersistence 不依赖 OKSRS,所以这里是个字面量——改档位编号必须与
    /// `FSRS.Grade` 同步。
    static let passingGrade = 3

    /// 纯函数,与桌面 build_review_stats 同一口径(规范 §6)。
    static func buildReviewStats(
        favorites: [FavoriteVocabulary],
        events: [ReviewEvent],
        packId: UUID?,
        dateLocal: String
    ) -> ReviewStats {
        // 撤销标记与被撤销的复习都不算（同步协议 §6）。
        let events = ReviewEvent.effective(events)
        let inPack: (FavoriteVocabulary) -> Bool = { favorite in
            packId.map { favorite.packIds.contains($0) } ?? true
        }
        let cardIds = Set(favorites.filter(inPack).map(\.id))

        // 今日新学/复习:按卡去重,新学优先
        var newCards: Set<UUID> = []
        var reviewCards: Set<UUID> = []
        // 今日**答对过**的卡。同一张卡当天可能 again→again→good,只要有一条通过就算通过。
        var passedCards: Set<UUID> = []
        for event in events where event.dateLocal == dateLocal {
            guard cardIds.contains(event.vocabularyId) else { continue }
            if event.previousState == .new {
                newCards.insert(event.vocabularyId)
            } else {
                reviewCards.insert(event.vocabularyId)
            }
            if event.grade >= Self.passingGrade {
                passedCards.insert(event.vocabularyId)
            }
        }
        let reviewToday = reviewCards.subtracting(newCards).count
        // 新学/复习的归属沿用上面同一套判定,保证 passed ≤ 对应的总数。
        let passedNewToday = passedCards.intersection(newCards).count
        let passedReviewToday = passedCards.subtracting(newCards).count

        // 连续打卡:全局(不过滤词包),从今日(或昨日)向前连续有事件的天数
        let eventDays = Set(events.map(\.dateLocal))
        var streak = 0
        if let today = parseLocalDate(dateLocal) {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "UTC")!
            var cursor = eventDays.contains(dateLocal)
                ? today
                : calendar.date(byAdding: .day, value: -1, to: today)!
            while eventDays.contains(formatLocalDate(cursor, calendar: calendar)) {
                streak += 1
                cursor = calendar.date(byAdding: .day, value: -1, to: cursor)!
            }
        }

        var stats = ReviewStats(
            newToday: newCards.count, reviewToday: reviewToday,
            passedNewToday: passedNewToday, passedReviewToday: passedReviewToday,
            streakDays: streak)
        for favorite in favorites where inPack(favorite) {
            stats.total += 1
            if favorite.suspendedAt != nil {
                stats.countSuspended += 1
            } else {
                switch favorite.srsState {
                case .learning: stats.countLearning += 1
                case .review: stats.countReview += 1
                case .new: stats.countNew += 1
                }
            }
        }
        return stats
    }

    // MARK: - 统计分析(图表序列)

    public func statistics(
        packId: UUID?, dateLocal: String, rangeDays: Int, forecastDays: Int
    ) async throws -> StudyStatistics {
        let (favorites, events, sessions) = try await database.writer.read { db in
            (
                try Self.fetchFavorites(db),
                try ReviewLogRecord.fetchAll(db).map { try $0.domainModel() },
                try ReadingSessionRecord.fetchAll(db).map { try $0.domainModel() }
            )
        }
        return Self.buildStudyStatistics(
            favorites: favorites, events: events, readingSessions: sessions,
            packId: packId, dateLocal: dateLocal,
            rangeDays: rangeDays, forecastDays: forecastDays)
    }

    /// 纯函数：从卡片 / 复习事件 / 阅读会话推导全部图表序列。
    /// 口径与 `buildReviewStats` 一致(UTC 公历)；时间序列均零填充(缺失日补 0)。
    static func buildStudyStatistics(
        favorites: [FavoriteVocabulary],
        events: [ReviewEvent],
        readingSessions: [ReadingSession],
        packId: UUID?,
        dateLocal: String,
        rangeDays: Int,
        forecastDays: Int
    ) -> StudyStatistics {
        let events = ReviewEvent.effective(events)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!

        // 状态分布 / 连续打卡 / 今日计数复用既有口径。
        let reviewStats = buildReviewStats(
            favorites: favorites, events: events, packId: packId, dateLocal: dateLocal)

        let inPack: (FavoriteVocabulary) -> Bool = { favorite in
            packId.map { favorite.packIds.contains($0) } ?? true
        }
        let cardIds = Set(favorites.filter(inPack).map(\.id))
        let scopedEvents = events.filter { cardIds.contains($0.vocabularyId) }

        // 每日复习活跃度：按天聚合，new 优先去重(同 buildReviewStats 今日口径)。
        var newByDay: [String: Set<UUID>] = [:]
        var reviewByDay: [String: Set<UUID>] = [:]
        for event in scopedEvents {
            if event.previousState == .new {
                newByDay[event.dateLocal, default: []].insert(event.vocabularyId)
            } else {
                reviewByDay[event.dateLocal, default: []].insert(event.vocabularyId)
            }
        }
        var dailyActivity: [StudyStatistics.DailyActivity] = []
        if let today = parseLocalDate(dateLocal), rangeDays > 0 {
            for offset in stride(from: rangeDays - 1, through: 0, by: -1) {
                guard let day = calendar.date(byAdding: .day, value: -offset, to: today)
                else { continue }
                let key = formatLocalDate(day, calendar: calendar)
                let newCards = newByDay[key] ?? []
                let reviewCards = (reviewByDay[key] ?? []).subtracting(newCards)
                dailyActivity.append(.init(
                    dateLocal: key, newCount: newCards.count, reviewCount: reviewCards.count))
            }
        }

        // 评分分布(全期，固定 4 桶)。
        var gradeMap: [Int: Int] = [1: 0, 2: 0, 3: 0, 4: 0]
        for event in scopedEvents where (1...4).contains(event.grade) {
            gradeMap[event.grade, default: 0] += 1
        }
        let gradeCounts = (1...4).map {
            StudyStatistics.GradeCount(grade: $0, count: gradeMap[$0] ?? 0)
        }

        // 复习预测：未 suspend 且 due_date 合法的卡；逾期(<=今日)并入首日；未排期排除。
        var forecast: [StudyStatistics.ForecastDay] = []
        let dueCandidates = favorites.filter {
            inPack($0) && $0.suspendedAt == nil && isValidLocalDate($0.dueDate)
        }
        if let today = parseLocalDate(dateLocal), forecastDays > 0 {
            for offset in 0..<forecastDays {
                guard let day = calendar.date(byAdding: .day, value: offset, to: today)
                else { continue }
                let key = formatLocalDate(day, calendar: calendar)
                let count = offset == 0
                    ? dueCandidates.filter { $0.dueDate <= dateLocal }.count
                    : dueCandidates.filter { $0.dueDate == key }.count
                forecast.append(.init(dateLocal: key, dueCount: count))
            }
        }

        // 阅读聚合。
        let monthPrefix = String(dateLocal.prefix(7))
        var readingByDate: [String: Int] = [:]
        var readingSecondsTotal = 0
        var readingSecondsToday = 0
        var readingSecondsThisMonth = 0
        var readingMonthDays: Set<String> = []
        for session in readingSessions {
            readingByDate[session.dateLocal, default: 0] += session.seconds
            readingSecondsTotal += session.seconds
            if session.dateLocal == dateLocal { readingSecondsToday += session.seconds }
            if session.dateLocal.hasPrefix(monthPrefix) {
                readingSecondsThisMonth += session.seconds
                readingMonthDays.insert(session.dateLocal)
            }
        }
        var readingByDay: [StudyStatistics.DailyReading] = []
        if let today = parseLocalDate(dateLocal), rangeDays > 0 {
            for offset in stride(from: rangeDays - 1, through: 0, by: -1) {
                guard let day = calendar.date(byAdding: .day, value: -offset, to: today)
                else { continue }
                let key = formatLocalDate(day, calendar: calendar)
                readingByDay.append(.init(dateLocal: key, seconds: readingByDate[key] ?? 0))
            }
        }

        return StudyStatistics(
            reviewStats: reviewStats,
            dailyActivity: dailyActivity,
            gradeCounts: gradeCounts,
            forecast: forecast,
            readingByDay: readingByDay,
            totalReviews: scopedEvents.count,
            activeDays: Set(scopedEvents.map(\.dateLocal)).count,
            readingSecondsToday: readingSecondsToday,
            readingSecondsThisMonth: readingSecondsThisMonth,
            readingDaysThisMonth: readingMonthDays.count,
            readingSecondsTotal: readingSecondsTotal,
            readingDaysTotal: Set(readingSessions.map(\.dateLocal)).count
        )
    }

    static func parseLocalDate(_ value: String) -> Date? {
        guard isValidLocalDate(value) else { return nil }
        let parts = value.split(separator: "-")
        var components = DateComponents()
        components.year = Int(parts[0])
        components.month = Int(parts[1])
        components.day = Int(parts[2])
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar.date(from: components)
    }

    static func formatLocalDate(_ date: Date, calendar: Calendar) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d-%02d-%02d",
            components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }

    // MARK: - 词包

    /// 新建词包。
    public func insertPack(_ pack: WordPack, now: Date = .now) async throws {
        let record = try WordPackRecord(pack, now: now)
        try await database.writer.write { db in
            try record.insert(db)
        }
    }

    /// 更新词包(重命名/改描述等;成员不在此处变更)。
    public func updatePack(_ pack: WordPack, now: Date = .now) async throws {
        let record = try WordPackRecord(pack, now: now)
        try await database.writer.write { db in
            try record.update(db)
        }
    }

    /// 删除词包(系统包不可删,镜像桌面 delete_word_pack_cmd):
    /// membership 由 FK 级联清除;删除后不属于任何词包的卡片归入"未分组"。
    public func deletePack(id: UUID, now: Date = .now) async throws {
        guard id != WordPack.systemUngroupedID else {
            throw DatabaseError(message: "system pack cannot be deleted")
        }
        let packId = uuidString(id)
        let defaultId = uuidString(WordPack.systemUngroupedID)
        try await database.writer.write { db in
            let memberIds = try WordPackMembershipRecord
                .filter(Column("pack_id") == packId)
                .fetchAll(db)
                .map(\.vocabularyId)
            _ = try WordPackRecord.deleteOne(db, key: packId)
            // 只记词包本身。它的 membership 由 FK 级联清除，导入方发现词包被删过
            // 就会连同指向它的所有关系一起跳过——一个包几百个词，逐条记墓碑纯属浪费。
            try TombstoneRecord.mark(db, table: .wordPack, id: id, at: now)
            for vocabularyId in memberIds {
                let remaining = try WordPackMembershipRecord
                    .filter(Column("vocabulary_id") == vocabularyId)
                    .fetchCount(db)
                if remaining == 0 {
                    try WordPackMembershipRecord(
                        vocabularyId: vocabularyId, packId: defaultId, createdAt: now
                    ).insert(db)
                }
            }
        }
    }

    /// 确保系统默认词包("未分组")存在;不可删除(规范 §1.2)。
    @discardableResult
    public func ensureDefaultPack(now: Date = .now) async throws -> WordPack {
        let defaultPack = WordPack(
            id: WordPack.systemUngroupedID,
            name: "未分组",
            packDescription: "系统默认合集",
            author: "OpenKoto",
            tags: ["system"],
            version: "1.0.0",
            isSystem: true,
            createdAt: now,
            updatedAt: now
        )
        let record = try WordPackRecord(defaultPack, now: now)
        return try await database.writer.write { db in
            if let existing = try WordPackRecord.fetchOne(
                db, key: uuidString(WordPack.systemUngroupedID))
            {
                return try existing.domainModel()
            }
            try record.insert(db)
            return defaultPack
        }
    }

    // MARK: - 删除墓碑(跨设备同步 / 导入去重)

    /// 某张表全部墓碑的 id 集合。
    ///
    /// 导入前一次性取出做集合判定，不要逐条查库——一个几千词的传输文件
    /// 会变成几千次单行查询。
    public func tombstoneIDs(for table: TombstoneTable) async throws -> Set<String> {
        try await database.writer.read { db in
            let ids = try String.fetchAll(
                db,
                sql: "SELECT record_id FROM deleted_record WHERE table_name = ?",
                arguments: [table.rawValue])
            return Set(ids)
        }
    }

    /// 全部墓碑，供导出与同步推送使用。
    public func allTombstones() async throws -> [Tombstone] {
        try await database.writer.read { db in
            try TombstoneRecord
                .order(Column("deleted_at"))
                .fetchAll(db)
                .compactMap(\.tombstone)  // 表名无法识别的历史行直接忽略
        }
    }

    /// 剪掉过期墓碑，返回清掉的条数。
    ///
    /// 在 App 启动时跑一次即可——墓碑的增长速度取决于用户删东西的频率，
    /// 不需要更勤。代价见 `Tombstone.retention` 的注释。
    @discardableResult
    public func pruneTombstones(
        now: Date = .now, retention: TimeInterval = Tombstone.retention
    ) async throws -> Int {
        let cutoff = Tombstone.pruneCutoff(now: now, retention: retention)
        return try await database.writer.write { db in
            try db.execute(
                sql: "DELETE FROM deleted_record WHERE deleted_at < ?", arguments: [cutoff])
            return db.changesCount
        }
    }

    // MARK: - 首启种子

    /// 仅在 article 表为空时写入内置示例内容（同一事务）。
    /// - Returns: 是否实际种子写入。
    @discardableResult
    public func seedIfEmpty(
        articles: [Article],
        segmentsByArticle: [UUID: [ArticleSegment]],
        now: Date = .now
    ) async throws -> Bool {
        try await database.writer.write { db in
            guard try ArticleRecord.fetchCount(db) == 0 else { return false }
            for article in articles {
                try ArticleRecord(article, now: now).insert(db)
                for segment in segmentsByArticle[article.id] ?? [] {
                    try SegmentRecord(segment, meta: nil, now: now).insert(db)
                }
            }
            return true
        }
    }
}
