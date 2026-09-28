import Foundation
import OKModels
import Testing

@testable import OKAccount
@testable import OKPersistence

/// `HTTPSyncEngine` 端到端：真的 `CloudAPIClient` + `HTTPSyncTransport`，
/// 经 URLProtocol 桩打到一个按 `vault.ts` 规则实现的假服务端。
@Suite struct HTTPSyncEngineTests {
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)  // 2026-09-21
    private var t1: Date { t0.addingTimeInterval(3600) }
    private var t2: Date { t0.addingTimeInterval(7200) }

    private func makeEngine(_ cloud: FakeCloud, repo: ContentRepository? = nil) throws
        -> (HTTPSyncEngine, ContentRepository)
    {
        let repository = try repo ?? ContentRepository(database: AppDatabase.inMemory())
        let engine = HTTPSyncEngine(
            repository: repository, transport: HTTPSyncTransport(api: cloud.client()),
            now: { [t2] in t2.addingTimeInterval(3600) })
        return (engine, repository)
    }

    private func vocab(
        id: UUID = UUID(), word: String = "夢", meaning: String = "梦", updatedAt: Date
    ) -> FavoriteVocabulary {
        FavoriteVocabulary(
            id: id, word: word, meaning: meaning, dueDate: "2026-09-21",
            createdAt: updatedAt, updatedAt: updatedAt)
    }

    private func event(for card: UUID, at date: Date, grade: Int = 3) -> ReviewEvent {
        ReviewEvent(
            vocabularyId: card, reviewedAt: date, dateLocal: "2026-09-21", grade: grade,
            elapsedDays: 0, previousState: .new, desiredRetention: 0.9, resultStability: 0,
            resultDifficulty: 0, resultIntervalDays: 0, resultState: .review)
    }

    private func sync(_ engine: HTTPSyncEngine) async throws {
        try await engine.pull()
        try await engine.push()
    }

    /// 远端 payload：iOS 编码 → JSON 值（模拟另一台 iOS / 其它客户端写入的内容）。
    private func payload<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONValue(jsonData: try CloudRecord.encoder().encode(value))
    }

    // MARK: - push

    @Test func firstSyncUploadsEverythingWithLowercaseIDs() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        let card = vocab(updatedAt: t0)
        try await repo.insertFavorite(card, now: t0)
        try await repo.applyReview(card, event: event(for: card.id, at: t1), now: t1)

        try await sync(engine)

        let id = card.id.uuidString.lowercased()
        let stored = try #require(cloud.record("Vocabulary", id))
        #expect(stored.id == id)
        #expect(stored.payload?["word"] == .string("夢"))
        #expect(HLCTimestamp.isValid(stored.hlc))
        #expect(stored.hlc.hasSuffix("-d7f1a2b3"), "nodeId 由服务端分配的 deviceId 派生")
        #expect(cloud.records.values.contains { $0.type == "ReviewEvent" })
        // 请求体里没有任何大写 id
        let ops = cloud.pushRequests.flatMap(\.ops)
        #expect(ops.allSatisfy { $0.id == $0.id.lowercased() })
        #expect(ops.allSatisfy { $0.baseRev == 0 })
    }

    @Test func secondSyncPushesNothing() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        try await repo.insertFavorite(vocab(updatedAt: t0), now: t0)
        try await sync(engine)
        let before = cloud.pushRequests.count
        try await sync(engine)
        #expect(cloud.pushRequests.count == before, "没有变更就不该再推（水位线 + 哈希去回声）")
    }

    @Test func editsArePushedWithTheLastSeenRev() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        var card = vocab(updatedAt: t0)
        try await repo.insertFavorite(card, now: t0)
        try await sync(engine)
        let firstRev = try #require(cloud.record("Vocabulary", card.id.uuidString)).rev

        card.meaning = "梦想"
        card.updatedAt = t2.addingTimeInterval(7200)  // 晚于上一轮的水位线
        try await repo.updateFavorite(card, now: card.updatedAt)
        try await sync(engine)

        let op = try #require(cloud.pushRequests.last?.ops.first)
        #expect(op.baseRev == firstRev)
        #expect(cloud.record("Vocabulary", card.id.uuidString)?.payload?["meaning"] == .string("梦想"))
    }

    @Test func localDeletionPushesATombstone() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        let card = vocab(updatedAt: t0)
        try await repo.insertFavorite(card, now: t0)
        try await sync(engine)
        try await repo.deleteFavorite(id: card.id, now: t2.addingTimeInterval(7200))
        try await sync(engine)
        let stored = try #require(cloud.record("Vocabulary", card.id.uuidString))
        #expect(stored.deleted)
        #expect(stored.payload == nil)
        let pushes = cloud.pushRequests.count
        try await sync(engine)
        #expect(cloud.pushRequests.count == pushes, "推过的墓碑不再重推")
    }

    // MARK: - pull

    @Test func pullAppliesRemoteRecordsAndReplaysReviews() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        let card = vocab(word: "懐かしい", updatedAt: t0)
        // 远端 id 是小写，payload 里的 UUID 是 iOS 编出来的大写 —— 都要认。
        cloud.write(
            type: "Vocabulary", id: card.id.uuidString.lowercased(),
            hlc: HLCTimestamp.legacy(t0, node: "bbbbbbbb").description, payload: try payload(card))
        let review = event(for: card.id, at: t1)
        cloud.write(
            type: "ReviewEvent", id: review.id.uuidString.lowercased(),
            hlc: HLCTimestamp.legacy(t1, node: "bbbbbbbb").description, payload: try payload(review))

        try await engine.pull()

        let favorites = try await repo.loadAll().favorites
        let local = try #require(favorites.first { $0.id == card.id })
        #expect(local.word == "懐かしい")
        #expect(local.reviewCount == 1, "复习事件到了就要重放，卡片状态不取 payload 快照")
        #expect(local.srsState != .new)
        #expect(try await repo.httpSyncState().cursor == "c_\(cloud.currentSeq)")

        // 刚拉下来的不应被原样推回去。卡片例外：它的 SRS 字段是本地重放算出来的，
        // 与远端快照（reviewCount 0）不同，推一次更新后的快照是预期行为。
        try await engine.push()
        let echoed = cloud.pushRequests.flatMap(\.ops)
        #expect(!echoed.contains { $0.type == "ReviewEvent" })
        #expect(echoed.allSatisfy { $0.type == "Vocabulary" && $0.baseRev > 0 })
        let pushes = cloud.pushRequests.count
        try await engine.pull()
        try await engine.push()
        #expect(cloud.pushRequests.count == pushes, "收敛：第二轮什么都不推")
    }

    @Test func acceptsMillisecondDatesFromOtherClients() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        let id = UUID()
        cloud.write(
            type: "Vocabulary", id: id.uuidString.lowercased(), hlc: "1790000000000-0000-cccccccc",
            payload: .object([
                "id": .string(id.uuidString.lowercased()), "word": .string("web"),
                "meaning": .string("m"), "srsState": .string("new"), "stability": .int(0),
                "difficulty": .int(0), "dueDate": .string("2026-09-28"), "reviewCount": .int(0),
                "createdAt": .string("2026-09-28T00:00:00.000Z"),
                "updatedAt": .string("2026-09-28T00:00:00.123Z"),
            ]))
        try await engine.pull()
        let favorites = try await repo.loadAll().favorites
        #expect(favorites.contains { $0.id == id && $0.word == "web" })
    }

    @Test func remoteTombstoneDeletesLocally() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        let card = vocab(updatedAt: t0)
        try await repo.insertFavorite(card, now: t0)
        try await sync(engine)
        cloud.write(type: "Vocabulary", id: card.id.uuidString, hlc: "1790100000000-0000-bbbbbbbb", payload: nil, deleted: true)
        try await sync(engine)
        #expect(try await repo.loadAll().favorites.isEmpty)
        #expect(cloud.record("Vocabulary", card.id.uuidString)?.deleted == true)
    }

    @Test func unknownTypesAreSkippedButTheCursorAdvances() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        cloud.write(type: "Setting", id: "learning.targetLanguage", hlc: "1790000000000-0000-bbbbbbbb", payload: .object(["value": .string("ja")]))
        cloud.write(type: "LyricsMeta", id: UUID().uuidString, hlc: "1790000000000-0001-bbbbbbbb", payload: .object([:]))
        try await engine.pull()
        #expect(try await repo.httpSyncState().cursor == "c_2")
    }

    @Test func paginatesUntilHasMoreIsFalse() async throws {
        let cloud = FakeCloud()
        let repository = try ContentRepository(database: AppDatabase.inMemory())
        let engine = HTTPSyncEngine(
            repository: repository, transport: HTTPSyncTransport(api: cloud.client()), pageSize: 2)
        for index in 0..<5 {
            let card = vocab(word: "w\(index)", updatedAt: t0)
            cloud.write(
                type: "Vocabulary", id: card.id.uuidString, hlc: "179000000000\(index)-0000-bbbbbbbb",
                payload: try payload(card))
        }
        try await engine.pull()
        #expect(try await repository.loadAll().favorites.count == 5)
        #expect(cloud.log.filter { $0.path == "/api/v1/sync/pull" }.count == 3)
    }

    // MARK: - 冲突

    /// 别的设备写了更新的版本：服务端回 conflict，本地合并后远端胜出，不再重推。
    @Test func conflictWithNewerRemoteAdoptsIt() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        var card = vocab(updatedAt: t0)
        try await repo.insertFavorite(card, now: t0)
        try await sync(engine)

        // 另一台设备在更晚的时刻改了释义
        var remote = card
        remote.meaning = "远端释义"
        remote.updatedAt = t2.addingTimeInterval(9000)
        cloud.write(
            type: "Vocabulary", id: card.id.uuidString,
            hlc: HLCTimestamp.legacy(remote.updatedAt, node: "bbbbbbbb").description,
            payload: try payload(remote))
        // 本机也改了，但时间更早 —— 而且还没 pull 就直接推
        card.meaning = "本地释义"
        card.updatedAt = t2.addingTimeInterval(7200)
        try await repo.updateFavorite(card, now: card.updatedAt)
        try await engine.push()

        #expect(await engine.lastReport.conflicts == 1)
        let local = try #require(try await repo.loadAll().favorites.first)
        #expect(local.meaning == "远端释义")
        #expect(cloud.record("Vocabulary", card.id.uuidString)?.payload?["meaning"] == .string("远端释义"))
    }

    /// 服务端那份 HLC 更大（比如别的客户端的时钟）但内容更旧：本地合并保留本地，
    /// 并以 `current.rev` 作 baseRev 重推成功。
    @Test func conflictWhereLocalWinsIsRepushedWithTheNewRev() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        var card = vocab(updatedAt: t0)
        try await repo.insertFavorite(card, now: t0)
        try await sync(engine)

        var remote = card
        remote.meaning = "旧的远端"
        remote.updatedAt = t0.addingTimeInterval(60)
        let remoteRev = cloud.write(
            type: "Vocabulary", id: card.id.uuidString, hlc: "9999999999999-0000-bbbbbbbb",
            payload: try payload(remote))

        card.meaning = "新的本地"
        card.updatedAt = t2.addingTimeInterval(7200)
        try await repo.updateFavorite(card, now: card.updatedAt)
        try await engine.push()

        let ops = cloud.pushRequests.suffix(2).flatMap(\.ops)
        #expect(ops.count == 2)
        #expect(ops.last?.baseRev == remoteRev)
        #expect(cloud.record("Vocabulary", card.id.uuidString)?.payload?["meaning"] == .string("新的本地"))
        #expect(try await repo.loadAll().favorites.first?.meaning == "新的本地")
    }

    // MARK: - 410 / 配额 / 换账号

    @Test func expiredCursorTriggersAFullRebuild() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        let remote = vocab(word: "云端", updatedAt: t0)
        cloud.write(type: "Vocabulary", id: remote.id.uuidString, hlc: "1790000000000-0000-bbbbbbbb", payload: try payload(remote))
        try await sync(engine)

        // 很久没同步：本地游标早于墓碑地板
        for _ in 0..<3 {
            let other = vocab(word: "x", updatedAt: t0)
            cloud.write(type: "Vocabulary", id: other.id.uuidString, hlc: "1790000000001-0000-bbbbbbbb", payload: try payload(other))
        }
        cloud.tombstoneFloor = cloud.currentSeq
        let local = vocab(word: "本地", updatedAt: t0)
        try await repo.insertFavorite(local, now: t0)  // updated_at 早于水位线：只有全量推才能推上去

        try await sync(engine)

        #expect(await engine.lastReport.rebuilt)
        #expect(try await repo.loadAll().favorites.count == 5)
        #expect(cloud.record("Vocabulary", local.id.uuidString) != nil, "重建后本地独有的记录要当新建推上去")
    }

    @Test func quotaRejectionsAreSurfacedAndRetriedLater() async throws {
        let cloud = FakeCloud()
        cloud.vocabularyLimit = 1
        let (engine, repo) = try makeEngine(cloud)
        try await repo.insertFavorite(vocab(word: "a", updatedAt: t0), now: t0)
        try await repo.insertFavorite(vocab(word: "b", updatedAt: t0), now: t0)
        try await engine.pull()
        await #expect(throws: HTTPSyncError.quotaExceeded(count: 1)) { try await engine.push() }
        #expect(try await repo.httpSyncState().watermark == nil, "被拒的要留在水位线之后，升级后还得推")

        cloud.vocabularyLimit = nil
        try await engine.push()
        #expect(cloud.records.values.filter { $0.type == "Vocabulary" }.count == 2)
    }

    @Test func switchingAccountsResetsProgress() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        try await repo.insertFavorite(vocab(updatedAt: t0), now: t0)
        try await sync(engine)
        #expect(try await repo.httpSyncState().account == cloud.userID)

        // 同一个库换了一个账号
        let other = FakeCloud()
        let store = InMemoryTokenStore(
            StoredSession(
                accessToken: "access-1", refreshToken: "okr_refresh-1",
                accessTokenExpiresAt: .now.addingTimeInterval(900), deviceId: "eeeeeeee-0000",
                user: AccountUser(id: "user-2", email: "b@example.com")))
        let engine2 = HTTPSyncEngine(repository: repo, transport: HTTPSyncTransport(api: other.client(store: store)))
        try await engine2.pull()
        try await engine2.push()
        #expect(other.records.values.contains { $0.type == "Vocabulary" }, "新账号要拿到本地的全部数据")
        #expect(try await repo.httpSyncState().account == "user-2")
    }

    // MARK: - 书与阅读进度

    @Test func bookProgressRoundTrips() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        let books = BookRepository(database: repo.database)
        let book = Book(title: "吾輩は猫である", format: .epub, dirName: "neko", createdAt: t0)
        let chapter = Article(title: "一", content: "吾輩は猫である。", createdAt: t0)
        try await books.insertBook(
            book, chapters: [(chapter, BookChapter(articleId: chapter.id, bookId: book.id, index: 0))], now: t0)
        try await books.saveProgress(BookProgress(bookId: book.id, chapterIndex: 0, updatedAt: t1))
        try await sync(engine)
        let pushed = try #require(cloud.record("BookProgress", book.id.uuidString))
        #expect(pushed.payload?["chapterIndex"] == .int(0))
        #expect(cloud.record("Book", book.id.uuidString) != nil)
        #expect(cloud.record("BookChapter", chapter.id.uuidString) != nil)

        // 另一台设备读到了第 3 章
        var remote = BookProgress(bookId: book.id, chapterIndex: 3, updatedAt: t2.addingTimeInterval(9000))
        remote.segmentOrder = 12
        cloud.write(type: "BookProgress", id: book.id.uuidString, hlc: "1790100000000-0000-bbbbbbbb", payload: try payload(remote))
        try await engine.pull()
        let progress = try await books.loadProgress()[book.id]
        #expect(progress?.chapterIndex == 3)
        #expect(progress?.segmentOrder == 12)
    }

    @Test func largePayloadsGoThroughBlobs() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        let big = Article(title: "長い章", content: String(repeating: "あ", count: 300_000), createdAt: t0)
        try await repo.insertArticle(big, segments: [], now: t0)
        try await sync(engine)
        let stored = try #require(cloud.record("Article", big.id.uuidString))
        #expect(stored.payload == nil)
        #expect(stored.blobKey?.hasPrefix("Article/") == true)

        // 另一台设备把它拉下来
        let (engine2, repo2) = try makeEngine(cloud)
        try await engine2.pull()
        let article = try await repo2.article(id: big.id)
        #expect(article?.content.count == 300_000)
    }

    // MARK: - 复习事件的撤销（同步协议 §6）

    @Test func voidMarkerFromTheWebUndoesAReview() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        let card = vocab(updatedAt: t0)
        try await repo.insertFavorite(card, now: t0)
        let review = event(for: card.id, at: t1)
        try await repo.applyReview(card, event: review, now: t1)
        try await sync(engine)

        // 网页端撤销：只带必填字段的标记
        let markerID = UUID()
        cloud.write(
            type: "ReviewEvent", id: markerID.uuidString.lowercased(), hlc: "1790100000000-0000-cccccccc",
            payload: .object([
                "id": .string(markerID.uuidString.lowercased()),
                "vocabularyId": .string(card.id.uuidString.lowercased()),
                "reviewedAt": .string("2026-09-21T02:00:00.000Z"), "grade": .int(0),
                "voidsEventId": .string(review.id.uuidString.lowercased()),
            ]))
        try await engine.pull()
        let local = try #require(try await repo.loadAll().favorites.first)
        #expect(local.reviewCount == 0)
        #expect(local.srsState == .new)
    }
}
