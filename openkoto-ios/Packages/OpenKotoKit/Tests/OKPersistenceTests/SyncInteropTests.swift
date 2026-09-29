import Foundation
import GRDB
import OKModels
import Testing

@testable import OKPersistence

/// 与网页 / 桌面互通相关的数据层规则：撤销标记不计入统计、宽松解码、歌词、同词合并。
@Suite struct SyncInteropTests {
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)  // 2026-09-21

    private func repo() throws -> ContentRepository {
        ContentRepository(database: try AppDatabase.inMemory())
    }

    private func card(_ word: String = "夢", id: UUID = UUID(), createdAt: Date) -> FavoriteVocabulary {
        FavoriteVocabulary(
            id: id, word: word, meaning: "m", dueDate: "2026-09-21", createdAt: createdAt,
            updatedAt: createdAt)
    }

    private func event(_ card: UUID, grade: Int, at: Date, voids: UUID? = nil, previous: SRSState = .new)
        -> ReviewEvent
    {
        ReviewEvent(
            vocabularyId: card, reviewedAt: at, dateLocal: "2026-09-21", grade: grade,
            elapsedDays: 0, previousState: previous, desiredRetention: 0.9, resultStability: 1,
            resultDifficulty: 5, resultIntervalDays: 1, resultState: .review, voidsEventId: voids)
    }

    private func payload<T: Encodable>(_ type: CloudRecordType, _ id: String, _ value: T, at: Date)
        throws -> CloudPayload
    {
        CloudPayload(type: type, id: id.lowercased(), data: try CloudRecord.encoder().encode(value), updatedAt: at)
    }

    private func jsonPayload(_ type: CloudRecordType, _ id: String, _ json: String, at: Date) -> CloudPayload {
        CloudPayload(type: type, id: id.lowercased(), data: Data(json.utf8), updatedAt: at)
    }

    // MARK: - 撤销标记与统计

    @Test func voidMarkersAndVoidedReviewsDoNotCountInStats() {
        let a = UUID()
        let b = UUID()
        let favorites = [card(id: a, createdAt: t0), card("b", id: b, createdAt: t0)]
        let reviewA = event(a, grade: 3, at: t0)
        let reviewB = event(b, grade: 1, at: t0)
        let undoB = event(b, grade: 0, at: t0.addingTimeInterval(5), voids: reviewB.id)
        let stats = ContentRepository.buildReviewStats(
            favorites: favorites, events: [reviewA, reviewB, undoB], packId: nil,
            dateLocal: "2026-09-21")
        #expect(stats.newToday == 1, "被撤销的那次复习不算今日新学")
        #expect(stats.passedNewToday == 1)
        #expect(stats.streakDays == 1)

        // 当天唯一的一次复习被撤销了：今天不算打卡
        let onlyUndone = ContentRepository.buildReviewStats(
            favorites: favorites, events: [reviewB, undoB], packId: nil, dateLocal: "2026-09-21")
        #expect(onlyUndone.newToday == 0)
        #expect(onlyUndone.streakDays == 0)
    }

    @Test func voidMarkersDoNotShowUpInTheGradeChart() {
        let a = UUID()
        let review = event(a, grade: 4, at: t0)
        let undo = event(a, grade: 0, at: t0.addingTimeInterval(5), voids: review.id)
        let stats = ContentRepository.buildStudyStatistics(
            favorites: [card(id: a, createdAt: t0)], events: [review, undo], readingSessions: [],
            packId: nil, dateLocal: "2026-09-21", rangeDays: 7, forecastDays: 7)
        #expect(stats.gradeCounts.allSatisfy { $0.count == 0 }, "grade 0 曾被归到 easy 那一栏")
        #expect(stats.dailyActivity.allSatisfy { $0.total == 0 })
    }

    // MARK: - 宽松解码（网页 / 桌面的 payload）

    @Test func webShapedPayloadsAreNotDropped() async throws {
        let repo = try repo()
        let bookID = UUID().uuidString.lowercased()
        let chapterID = UUID().uuidString.lowercased()
        let segmentID = UUID().uuidString.lowercased()
        let packID = UUID().uuidString.lowercased()
        let markID = UUID().uuidString.lowercased()
        let payloads = [
            // 网页导入的书：没有 dirName / opfPath，日期带毫秒
            jsonPayload(.book, bookID, """
                {"id":"\(bookID)","title":"Web Book","format":"epub","totalChars":10,
                 "defaultMode":"original","originalOnly":false,"createdAt":"2026-09-28T10:00:00.123Z"}
                """, at: t0),
            jsonPayload(.article, chapterID, """
                {"id":"\(chapterID)","title":"第一章","content":"吾輩は猫である。名前はまだ無い。",
                 "sourceType":"book","createdAt":"2026-09-28T10:00:00.123Z"}
                """, at: t0),
            jsonPayload(.bookChapter, chapterID, """
                {"articleId":"\(chapterID)","bookId":"\(bookID)","index":0,"title":"第一章"}
                """, at: t0),
            jsonPayload(.segment, segmentID, """
                {"id":"\(segmentID)","articleId":"\(chapterID)","order":0,"text":"吾輩は猫である。",
                 "createdAt":"2026-09-28T10:00:00.5Z","segmentationRevision":2,
                 "explanation":{"translation":"我是猫","unknownShape":true}}
                """, at: t0),
            jsonPayload(.wordPack, packID, """
                {"id":"\(packID)","name":"Web pack","createdAt":"2026-09-28T10:00:00.000Z"}
                """, at: t0),
            jsonPayload(.bookMark, markID, """
                {"id":"\(markID)","bookId":"\(bookID)","kind":"note","chapterIndex":0,
                 "createdAt":"2026-09-28T10:00:00.000Z","updatedAt":"2026-09-28T10:00:01.000Z"}
                """, at: t0),
        ]
        let applied = try await repo.applyCloudPayloads(payloads)
        #expect(applied == payloads.count)
        #expect(try await repo.pendingCloudPayloadCount() == 0)

        let books = BookRepository(database: repo.database)
        let book = try #require(try await books.loadBooks().first)
        #expect(book.dirName == bookID, "没有 dirName 时用书 id")
        #expect(try await books.chapterSummaries(bookID: book.id).map(\.title) == ["第一章"])
        let article = try #require(try await repo.article(id: UUID(uuidString: chapterID)!))
        #expect(article.sourceType == .book)
        #expect(try await repo.loadSegments(articleID: article.id).count == 1)
        #expect(try await books.marks(bookID: book.id).first?.kind == .highlight)
    }

    @Test func unknownSourceTypesLoadAsArticles() async throws {
        let repo = try repo()
        let id = UUID().uuidString.lowercased()
        try await repo.applyCloudPayloads([
            jsonPayload(.article, id, """
                {"id":"\(id)","title":"t","content":"c","sourceType":"podcast","createdAt":"2026-09-28T10:00:00Z"}
                """, at: t0)
        ])
        #expect(try await repo.loadAll().articles.first { $0.id.uuidString.lowercased() == id }?.sourceType == .article)
    }

    // MARK: - 歌词

    @Test func lyricsMetaWaitsForItsArticleAndSurvivesTheRoundTrip() async throws {
        let repo = try repo()
        let article = Article(title: "夜に駆ける", content: "[00:01.00]沈むように", sourceType: .lyrics, createdAt: t0)
        let meta = LyricsMeta(articleId: article.id, artist: "YOASOBI", lrcOffsetMs: -200, sourceFormat: .lrc, musicLinks: ["https://example.com"])
        // 元数据先到：停放
        try await repo.applyCloudPayloads([try payload(.lyricsMeta, article.id.uuidString, meta, at: t0)])
        #expect(try await repo.pendingCloudPayloadCount() == 1)
        try await repo.applyCloudPayloads([try payload(.article, article.id.uuidString, article, at: t0)])
        #expect(try await repo.pendingCloudPayloadCount() == 0)
        #expect(try await repo.loadLyricsMeta()[article.id] == meta)

        let pending = try await repo.pendingCloudPayloads(since: nil, options: .openKoto)
        #expect(pending.contains { $0.type == .lyricsMeta && $0.id == article.id.uuidString.lowercased() })
        #expect(!(try await repo.pendingCloudPayloads(since: nil)).contains { $0.type == .lyricsMeta },
            "CloudKit 不同步歌词元数据")
    }

    // MARK: - 同词合并（协议 §9）

    @Test func remoteDuplicateWithEarlierCreationWins() async throws {
        let repo = try repo()
        let local = card(createdAt: t0.addingTimeInterval(3600))
        try await repo.insertFavorite(local, now: local.createdAt)
        let review = event(local.id, grade: 3, at: t0.addingTimeInterval(7200))
        try await repo.applyReview(local, event: review, now: review.reviewedAt)

        let remote = card(createdAt: t0)  // 更早：留下
        try await repo.applyCloudPayloads([try payload(.vocabulary, remote.id.uuidString, remote, at: t0)])

        let favorites = try await repo.loadAll().favorites
        #expect(favorites.map(\.id) == [remote.id])
        #expect(favorites.first?.reviewCount == 1, "被合并方的复习改指到保留卡并重放")
        #expect(try await repo.tombstoneIDs(for: .favoriteVocabulary).contains(local.id.uuidString.lowercased()))

        // 复制事件 + 撤销标记都会上 OpenKoto 云（即使 reviewed_at 早于水位线）
        let events = try await repo.pendingCloudPayloads(since: t0.addingTimeInterval(99_999), options: .openKoto)
            .filter { $0.type == .reviewEvent }
        #expect(events.count == 3)
        #expect(ContentRepository.derivedID("copy", review.id.uuidString, remote.id.uuidString)
            == ContentRepository.derivedID("copy", review.id.uuidString.uppercased(), remote.id.uuidString.lowercased()),
            "派生 id 与大小写无关：两台设备算出同一个 id")
    }

    @Test func localDuplicateWithEarlierCreationWinsAndLateEventsAreRepointed() async throws {
        let repo = try repo()
        let local = card(createdAt: t0)
        try await repo.insertFavorite(local, now: t0)
        let remote = card(createdAt: t0.addingTimeInterval(3600))
        let remoteReview = event(remote.id, grade: 3, at: t0.addingTimeInterval(7200))
        try await repo.applyCloudPayloads([
            try payload(.vocabulary, remote.id.uuidString, remote, at: remote.createdAt),
            try payload(.reviewEvent, remoteReview.id.uuidString, remoteReview, at: remoteReview.reviewedAt),
        ])
        let favorites = try await repo.loadAll().favorites
        #expect(favorites.map(\.id) == [local.id])
        #expect(favorites.first?.reviewCount == 1)
        #expect(try await repo.tombstoneIDs(for: .favoriteVocabulary).contains(remote.id.uuidString.lowercased()))
        #expect(try await repo.pendingCloudPayloadCount() == 0)
    }

    @Test func sameWordFromDifferentArticlesIsNotMerged() async throws {
        let repo = try repo()
        let article = Article(title: "a", content: "x", createdAt: t0)
        try await repo.insertArticle(article, segments: [], now: t0)
        var local = card(createdAt: t0)
        local.sourceArticleId = article.id
        try await repo.insertFavorite(local, now: t0)
        let remote = card(createdAt: t0.addingTimeInterval(-60))  // 无来源
        try await repo.applyCloudPayloads([try payload(.vocabulary, remote.id.uuidString, remote, at: t0)])
        #expect(try await repo.loadAll().favorites.count == 2)
    }
}
