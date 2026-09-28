import Foundation
import OKBooks
import OKModels
import OKPersistence
import Testing

@testable import OKFeatures

/// 自动同步触发（写入后防抖 / 前台定时）与网页数据在 iOS 上的可用性。
@MainActor
@Suite struct AutoSyncAndInteropTests {
    final class CountingEngine: SyncEngine, @unchecked Sendable {
        private let lock = NSLock()
        private var _pulls = 0
        var pulls: Int { lock.withLock { _pulls } }
        func pull() async throws { lock.withLock { _pulls += 1 } }
        func push() async throws {}
    }

    private func makeStore(bookStorage: BookStorage? = nil) throws -> (ContentStore, ContentRepository, BookRepository, UserDefaults) {
        let suite = "AutoSyncTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let database = try AppDatabase.inMemory()
        let repository = ContentRepository(database: database)
        let books = BookRepository(database: database)
        let store = ContentStore(
            repository: repository, bookRepository: books, bookStorage: bookStorage, defaults: defaults)
        return (store, repository, books, defaults)
    }

    private func waitUntil(_ condition: () -> Bool, timeout: TimeInterval = 3) async {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    @Test func localWritesTriggerADebouncedSync() async throws {
        let (store, repository, _, defaults) = try makeStore()
        let engine = CountingEngine()
        store.syncEngineFactory = { _ in engine }
        defaults.set(SyncProvider.openkoto.rawValue, forKey: ContentStore.syncProviderKey)
        store.syncDebounceInterval = 0.2
        store.startAutoSync()
        defer { store.stopAutoSync() }

        // 连续三次写入只触发一轮同步
        for word in ["a", "b", "c"] {
            try await repository.insertFavorite(
                FavoriteVocabulary(word: word, meaning: "m", dueDate: "2026-09-21"))
        }
        await waitUntil { engine.pulls >= 1 }
        #expect(engine.pulls == 1)
        // 同步自己写库不应再引出一轮
        try? await Task.sleep(nanoseconds: 500_000_000)
        #expect(engine.pulls == 1)
    }

    @Test func noAutoSyncUnlessOpenKotoIsSelected() async throws {
        let (store, repository, _, defaults) = try makeStore()
        let engine = CountingEngine()
        store.syncEngineFactory = { _ in engine }
        defaults.set(SyncProvider.icloud.rawValue, forKey: ContentStore.syncProviderKey)
        store.syncDebounceInterval = 0.05
        store.startAutoSync()
        defer { store.stopAutoSync() }
        try await repository.insertFavorite(FavoriteVocabulary(word: "a", meaning: "m", dueDate: "2026-09-21"))
        try? await Task.sleep(nanoseconds: 300_000_000)
        #expect(engine.pulls == 0)
    }

    @Test func periodicSyncRunsWhileInTheForeground() async throws {
        let (store, _, _, defaults) = try makeStore()
        let engine = CountingEngine()
        store.syncEngineFactory = { _ in engine }
        defaults.set(SyncProvider.openkoto.rawValue, forKey: ContentStore.syncProviderKey)
        store.periodicSyncInterval = 0.1
        store.startPeriodicSync()
        await waitUntil { engine.pulls >= 2 }
        store.stopPeriodicSync()
        let settled = engine.pulls
        #expect(settled >= 2)
        try? await Task.sleep(nanoseconds: 300_000_000)
        #expect(engine.pulls == settled, "进后台就停")
    }

    /// 网页导入的书：没有 EPUB 文件、没有句子，只有章节正文 —— 原生模式照样能读。
    @Test func webImportedBookOpensInNativeMode() async throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("okweb-\(UUID().uuidString)")
        let storage = BookStorage(root: root)
        try storage.prepare()
        let (store, repository, _, _) = try makeStore(bookStorage: storage)
        let bookID = UUID().uuidString.lowercased()
        let chapterID = UUID().uuidString.lowercased()
        let at = Date(timeIntervalSince1970: 1_790_000_000)
        try await repository.applyCloudPayloads([
            CloudPayload(type: .book, id: bookID, data: Data("""
                {"id":"\(bookID)","title":"Web Book","format":"epub","totalChars":16,"defaultMode":"original",
                 "originalOnly":false,"createdAt":"2026-09-28T10:00:00.123Z"}
                """.utf8), updatedAt: at),
            CloudPayload(type: .article, id: chapterID, data: Data("""
                {"id":"\(chapterID)","title":"第一章","content":"吾輩は猫である。名前はまだ無い。",
                 "sourceType":"book","createdAt":"2026-09-28T10:00:00.123Z"}
                """.utf8), updatedAt: at),
            CloudPayload(type: .bookChapter, id: chapterID, data: Data("""
                {"articleId":"\(chapterID)","bookId":"\(bookID)","index":0,"title":"第一章"}
                """.utf8), updatedAt: at),
        ])
        await store.load()
        let book = try #require(store.books.first)
        #expect(book.title == "Web Book")
        #expect(!store.articles.contains { $0.id.uuidString.lowercased() == chapterID }, "章节不出现在文章列表")
        let chapterUUID = try #require(UUID(uuidString: chapterID))
        await store.openArticle(chapterUUID)
        #expect(store.segments(for: chapterUUID).map(\.text) == ["吾輩は猫である。", "名前はまだ無い。"])
    }

    @Test func lrcLyricsWithoutSyncedSegmentsAreSplitIntoTimedLines() {
        let article = Article(
            title: "Song", content: "[ar:Singer]\n[offset:500]\n[00:12.50][00:40.00]hello\n[00:20.00]world\nuntimed",
            sourceType: .lyrics)
        let lines = LyricsLines.segments(for: article)
        #expect(lines.map(\.text) == ["hello", "world", "hello", "untimed"])
        #expect(lines.first?.startTime == 12.0, "应用 [offset:+500] = 提前 0.5 秒")
        #expect(lines.first?.endTime == 19.5)
        #expect(lines.last?.startTime == nil)
    }
}
