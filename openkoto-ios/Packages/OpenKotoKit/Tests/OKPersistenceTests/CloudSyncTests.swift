import CloudKit
import Foundation
import GRDB
import OKModels
import Testing

@testable import OKPersistence

/// CloudKit 同步的数据层（跨设备同步 P3）。
///
/// CloudKit 本身的往返（真机、两台设备、同一个 iCloud 账号）没法在这里跑，
/// 所以**能验的每一条都必须验**：变更收集、冲突合并、删除传播、复习重放。
/// 这些恰恰也是出了错最不容易被发现的地方 —— 同步的失败模式几乎全是静默的。
@Suite struct CloudSyncTests {
    private let t0 = Date(timeIntervalSince1970: 1_700_000_000)
    private var t1: Date { t0.addingTimeInterval(3600) }
    private var t2: Date { t0.addingTimeInterval(7200) }

    private func makeRepository() throws -> ContentRepository {
        ContentRepository(database: try AppDatabase.inMemory())
    }

    private func makeVocab(
        id: UUID = UUID(), word: String = "夢", meaning: String = "梦", updatedAt: Date
    ) -> FavoriteVocabulary {
        FavoriteVocabulary(
            id: id, word: word, meaning: meaning, dueDate: "2026-01-01",
            createdAt: updatedAt, updatedAt: updatedAt)
    }

    private func payload(_ vocab: FavoriteVocabulary) throws -> CloudPayload {
        CloudPayload(
            type: .vocabulary, id: vocab.id.uuidString.lowercased(),
            data: try CloudRecord.encoder().encode(vocab), updatedAt: vocab.updatedAt)
    }

    // MARK: - 记录命名

    /// 记录名带类型前缀是必需的：词包成员的键是 `vocabId:packId`，
    /// 而文章与句子各有自己的 UUID 空间。
    @Test func recordNamesRoundTrip() throws {
        let name = CloudRecord.recordName(.vocabulary, "AABBCCDD-1111-2222-3333-444455556666")
        #expect(name == "Vocabulary_aabbccdd-1111-2222-3333-444455556666")
        let parsed = try #require(CloudRecord.parse(recordName: name))
        #expect(parsed.type == .vocabulary)
        #expect(parsed.id == "aabbccdd-1111-2222-3333-444455556666")
    }

    /// 词包成员的 id 自带一个下划线，解析必须只切第一个。
    /// **分隔符不能用冒号**：CloudKit 会回 `serverRejectedRequest`（实测过），
    /// 而且这种记录名会带两个冒号。
    @Test func membershipRecordNameSurvivesItsOwnSeparator() throws {
        let key = Tombstone.membershipKey(vocabularyID: UUID(), packID: UUID())
        let parsed = try #require(
            CloudRecord.parse(recordName: CloudRecord.recordName(.wordPackMembership, key)))
        #expect(parsed.type == .wordPackMembership)
        #expect(parsed.id == key)
    }

    @Test func unknownRecordNamesAreRejected() {
        #expect(CloudRecord.parse(recordName: "NotAType_abc") == nil)
        #expect(CloudRecord.parse(recordName: "noseparator") == nil)
    }

    // MARK: - 变更收集（水位线）

    @Test func firstSyncCollectsEverything() async throws {
        let repo = try makeRepository()
        try await repo.insertFavorite(makeVocab(updatedAt: t0), now: t0)

        let payloads = try await repo.pendingCloudPayloads(since: nil)
        #expect(payloads.contains { $0.type == .vocabulary })
    }

    @Test func laterSyncsOnlyCollectWhatChanged() async throws {
        let repo = try makeRepository()
        try await repo.insertFavorite(makeVocab(word: "旧", updatedAt: t0), now: t0)
        try await repo.setSyncWatermark(t1)
        try await repo.insertFavorite(makeVocab(word: "新", updatedAt: t2), now: t2)

        let payloads = try await repo.pendingCloudPayloads(since: t1)
        let words = try payloads.filter { $0.type == .vocabulary }.map {
            try CloudRecord.decoder().decode(FavoriteVocabulary.self, from: $0.data).word
        }
        #expect(words == ["新"])
    }

    /// SQLite 的时间戳只到秒，"读水位线"与"写数据"在同一秒内没有先后保证。
    /// 不向前重叠就会漏推，而**漏推是永久性的数据不一致**（重推只是浪费流量）。
    @Test func watermarkOverlapsBackwardsSoNothingIsMissed() async throws {
        let repo = try makeRepository()
        // 数据的时间戳比水位线早 2 秒，落在 5 秒重叠窗口里
        try await repo.insertFavorite(makeVocab(updatedAt: t1.addingTimeInterval(-2)), now: t1)

        let payloads = try await repo.pendingCloudPayloads(since: t1)
        #expect(payloads.contains { $0.type == .vocabulary })
    }

    @Test func systemPackIsNeverPushed() async throws {
        let repo = try makeRepository()
        _ = try await repo.ensureDefaultPack(now: t0)
        let payloads = try await repo.pendingCloudPayloads(since: nil)
        #expect(!payloads.contains { $0.type == .wordPack })
    }

    @Test func deletionsComeFromTombstones() async throws {
        let repo = try makeRepository()
        let vocab = makeVocab(updatedAt: t0)
        try await repo.insertFavorite(vocab, now: t0)
        try await repo.deleteFavorite(id: vocab.id, now: t1)

        let deletions = try await repo.pendingCloudDeletions(since: nil)
        #expect(deletions.contains { $0.type == .vocabulary && $0.id == vocab.id.uuidString.lowercased() })
    }

    // MARK: - 书籍与视频的文本同步

    /// 一台设备一个库：`BookRepository` / `MediaRepository` / `ContentRepository` 共用同一个库。
    private func makeDevice() throws -> (
        content: ContentRepository, books: BookRepository, media: MediaRepository
    ) {
        let database = try AppDatabase.inMemory()
        return (
            ContentRepository(database: database), BookRepository(database: database),
            MediaRepository(database: database)
        )
    }

    private func makeBook(
        title: String = "夢十夜", originalOnly: Bool = false
    ) -> Book {
        Book(
            title: title, format: .txt, dirName: UUID().uuidString,
            originalOnly: originalOnly, createdAt: t0)
    }

    private func chapterEntry(
        book: Book, index: Int = 0, title: String = "第一夜", content: String = "こんな夢を見た。"
    ) -> (article: Article, chapter: BookChapter) {
        let article = Article(title: title, content: content, createdAt: t0)
        return (
            article,
            BookChapter(articleId: article.id, bookId: book.id, index: index, charCount: 8)
        )
    }

    private func cloudPayload(_ type: CloudRecordType, _ id: UUID, _ model: some Encodable)
        throws -> CloudPayload
    {
        CloudPayload(
            type: type, id: id.uuidString.lowercased(),
            data: try CloudRecord.encoder().encode(model), updatedAt: t0)
    }

    /// **本组最重要的一条。** 对端拿到的必须是**一本书**，而不是 N 篇散文章。
    ///
    /// 章节正文也是 `article` 行，靠 `book_chapter` 关联表才被挡在书库列表之外
    /// （`loadAll` 里的过滤）。关联表不同步的话对端只收到光秃秃的章节文章，
    /// 那个过滤条件直接失效 —— 一本 100 章的小说变成书库里 100 篇散文章。
    @Test func bookArrivesAsOneBookNotLooseArticles() async throws {
        let a = try makeDevice()
        let book = makeBook()
        let entry = chapterEntry(book: book)
        try await a.books.insertBook(book, chapters: [entry], now: t0)
        try await a.content.replaceSegments(
            articleID: entry.article.id,
            segments: [
                ArticleSegment(
                    articleId: entry.article.id, order: 0, text: "こんな夢を見た。", createdAt: t0)
            ],
            now: t0)

        let pushed = try await a.content.pendingCloudPayloads(since: nil)
        let b = try makeDevice()
        _ = try await b.content.applyCloudPayloads(pushed, now: t1)

        #expect(try await b.books.loadBooks().map(\.title) == ["夢十夜"])
        let summaries = try await b.books.chapterSummaries(bookID: book.id)
        #expect(summaries.map(\.title) == ["第一夜"])
        // 章节没有漏进书库顶层列表
        #expect(try await b.content.loadAll().articles.isEmpty)
        // 正文与句子都在 —— 原生模式据此就能读，不需要 EPUB 文件
        #expect(try await b.content.loadSegments(articleID: entry.article.id).count == 1)
        #expect(try await b.content.pendingCloudPayloadCount() == 0)
    }

    /// 固定版式书（抽不出正文）**一条记录都不推**。
    ///
    /// 它到了对端是彻底死的：原生模式被 `originalOnly` 禁死、原版模式又没有文件，
    /// 一个字都看不到。书库里多一条打不开的条目，不如干脆不推。
    @Test func fixedLayoutBooksAreNeverPushed() async throws {
        let a = try makeDevice()
        let normal = makeBook(title: "夢十夜")
        let fixed = makeBook(title: "画集", originalOnly: true)
        let normalEntry = chapterEntry(book: normal)
        let fixedEntry = chapterEntry(book: fixed, title: "图版一", content: "")
        try await a.books.insertBook(normal, chapters: [normalEntry], now: t0)
        try await a.books.insertBook(fixed, chapters: [fixedEntry], now: t0)
        try await a.content.replaceSegments(
            articleID: fixedEntry.article.id,
            segments: [
                ArticleSegment(articleId: fixedEntry.article.id, order: 0, text: "图版", createdAt: t0)
            ],
            now: t0)

        let pushed = try await a.content.pendingCloudPayloads(since: nil)
        let ids = Set(pushed.map(\.id))
        #expect(!ids.contains(fixed.id.uuidString.lowercased()))
        #expect(!ids.contains(fixedEntry.article.id.uuidString.lowercased()))
        #expect(pushed.filter { $0.type == .segment }.isEmpty)
        // 正常那本照推
        #expect(ids.contains(normal.id.uuidString.lowercased()))
        #expect(ids.contains(normalEntry.article.id.uuidString.lowercased()))
    }

    /// 视频字幕文稿与精讲照常同步，播放不可用由已有的降级 UI 处理。
    @Test func mediaTranscriptsSyncWithoutTheFile() async throws {
        let a = try makeDevice()
        let mediaID = UUID()
        let transcript = Article(title: "讲座", content: "字幕全文", createdAt: t0)
        try await a.media.insertMedia(
            Media(
                id: mediaID, title: "讲座", kind: .video, dirName: "d", fileName: "v.mp4",
                transcriptSource: .srt, createdAt: t0),
            article: transcript,
            part: MediaPart(articleId: transcript.id, mediaId: mediaID),
            segments: [
                ArticleSegment(
                    articleId: transcript.id, order: 0, text: "字幕全文", startTime: 1,
                    createdAt: t0)
            ],
            now: t0)

        let pushed = try await a.content.pendingCloudPayloads(since: nil)
        let b = try makeDevice()
        _ = try await b.content.applyCloudPayloads(pushed, now: t1)

        #expect(try await b.media.loadMedia().map(\.title) == ["讲座"])
        #expect(try await b.content.loadSegments(articleID: transcript.id).first?.startTime == 1)
        // 文稿没有漏进书库顶层列表
        #expect(try await b.content.loadAll().articles.isEmpty)
    }

    /// **security-scoped bookmark 绝不上云。** 它是设备本地的，传过去解析不出来，
    /// 还会让对端的 `mediaFileURL` 反复走 `refreshBookmark` 那条死路。
    @Test func bookmarkDataIsNeverPushed() async throws {
        let a = try makeDevice()
        let mediaID = UUID()
        let transcript = Article(title: "引用的视频", content: "字幕", createdAt: t0)
        try await a.media.insertMedia(
            Media(
                id: mediaID, title: "引用的视频", kind: .video, dirName: "d", fileName: nil,
                bookmarkData: Data([1, 2, 3, 4]), transcriptSource: .srt, createdAt: t0),
            article: transcript,
            part: MediaPart(articleId: transcript.id, mediaId: mediaID), segments: [], now: t0)

        let payload = try #require(
            try await a.content.pendingCloudPayloads(since: nil).first { $0.type == .media })
        let decoded = try CloudRecord.decoder().decode(Media.self, from: payload.data)
        #expect(decoded.bookmarkData == nil)
        #expect(decoded.title == "引用的视频")
    }

    // MARK: - 依赖没到就停放，别静默丢掉

    /// **依赖晚一批到达时，原来的写法是永久丢失。**
    ///
    /// `guard … else { return false }` 静默跳过，而 CloudKit 的 change token 照样前进
    /// —— 那条记录再也不会被下发。同一批内靠 `mergeOrder` 排序能解决，跨批次不能，
    /// 而一本 100 章的书**必然**跨批次。
    @Test func parkedRecordsAreRetriedWhenTheirDependencyArrives() async throws {
        let b = try makeDevice()
        let book = makeBook()
        let entry = chapterEntry(book: book)

        // 第一批：只有章节归属，article 与 book 都还没到
        let first = try await b.content.applyCloudPayloads(
            [try cloudPayload(.bookChapter, entry.article.id, entry.chapter)], now: t1)
        #expect(first == 0)
        #expect(try await b.content.pendingCloudPayloadCount() == 1)
        #expect(try await b.books.chapterSummaries(bookID: book.id).isEmpty)

        // 第二批：依赖到了 —— 停放的那条要在同一次调用里被重放成功
        let second = try await b.content.applyCloudPayloads(
            [
                try cloudPayload(.book, book.id, book),
                try cloudPayload(.article, entry.article.id, entry.article),
            ], now: t1)
        #expect(second == 3)  // book + article + 补上的章节归属
        #expect(try await b.content.pendingCloudPayloadCount() == 0)
        #expect(try await b.books.chapterSummaries(bookID: book.id).map(\.title) == ["第一夜"])
    }

    /// 孤儿句子也停放，而不是丢掉。
    @Test func orphanSegmentsAreParkedNotDropped() async throws {
        let b = try makeDevice()
        let article = Article(title: "普通文章", content: "正文", createdAt: t0)
        let segment = ArticleSegment(articleId: article.id, order: 0, text: "正文", createdAt: t0)

        #expect(try await b.content.applyCloudPayloads([try cloudPayload(.segment, segment.id, segment)], now: t1) == 0)
        #expect(try await b.content.pendingCloudPayloadNames() == ["Segment_\(segment.id.uuidString.lowercased())"])

        #expect(try await b.content.applyCloudPayloads([try cloudPayload(.article, article.id, article)], now: t1) == 2)
        #expect(try await b.content.loadSegments(articleID: article.id).count == 1)
    }

    /// 停放不能无限攒着。超龄的丢掉 —— 但**丢弃要留痕**（`cloudLogger.notice`），
    /// 静默地少点东西正是这一整轮 bug 的共同形状。
    @Test func staleParkedRecordsArePruned() async throws {
        let b = try makeDevice()
        let book = makeBook()
        let entry = chapterEntry(book: book)
        _ = try await b.content.applyCloudPayloads(
            [try cloudPayload(.bookChapter, entry.article.id, entry.chapter)], now: t1)
        #expect(try await b.content.pendingCloudPayloadCount() == 1)

        // 31 天之后：超过 30 天上限
        let later = t1.addingTimeInterval(31 * 24 * 3600)
        _ = try await b.content.applyCloudPayloads([], now: later)
        #expect(try await b.content.pendingCloudPayloadCount() == 0)
    }

    /// **一次同步会拆成很多批次，每批都重试一遍停放的记录。**
    ///
    /// 次数上限当成主判据的话（我第一版写的 20 次），一本 100 章的书拆成十几批时
    /// 次数几十下就烧完了 —— 那条章节归属会在它的 article 还没到之前就被丢掉，
    /// 而这正是停放机制要防的事。真正的上限必须是**时间**。
    @Test func parkedRecordsSurviveManyBatchesBeforeTheirDependencyArrives() async throws {
        let b = try makeDevice()
        let book = makeBook()
        let entry = chapterEntry(book: book)
        _ = try await b.content.applyCloudPayloads(
            [try cloudPayload(.bookChapter, entry.article.id, entry.chapter)], now: t1)

        // 同一次同步里的几十个后续批次
        for _ in 0..<40 {
            _ = try await b.content.applyCloudPayloads([], now: t1)
        }
        #expect(try await b.content.pendingCloudPayloadCount() == 1)

        _ = try await b.content.applyCloudPayloads(
            [
                try cloudPayload(.book, book.id, book),
                try cloudPayload(.article, entry.article.id, entry.article),
            ], now: t1)
        #expect(try await b.books.chapterSummaries(bookID: book.id).map(\.title) == ["第一夜"])
    }

    /// **墓碑是终局,不该停放。**
    ///
    /// 用户删掉一本书之后,云端还会陆续下发那本书的句子与章节归属。
    /// 那些父记录永远不会回来(墓碑挡着),停放只是白占 30 天、每轮还重试一次。
    /// 实测 Mac 上就攒了一批这样的行。
    @Test func recordsWhoseParentIsTombstonedAreSkippedNotParked() async throws {
        let b = try makeDevice()
        let book = makeBook()
        let entry = chapterEntry(book: book)

        // 模拟"这本书连章节一起被删过"
        try await b.content.applyCloudDeletions(
            [
                (.book, book.id.uuidString.lowercased()),
                (.article, entry.article.id.uuidString.lowercased()),
            ], now: t1)

        let segment = ArticleSegment(
            articleId: entry.article.id, order: 0, text: "こんな夢を見た。", createdAt: t0)
        let applied = try await b.content.applyCloudPayloads(
            [
                try cloudPayload(.segment, segment.id, segment),
                try cloudPayload(.bookChapter, entry.article.id, entry.chapter),
            ], now: t2)

        #expect(applied == 0)
        #expect(try await b.content.pendingCloudPayloadCount() == 0)
    }

    // MARK: - 书签 / 划线

    @Test func bookMarksRoundTripAndStayDeleted() async throws {
        let a = try makeDevice()
        let book = makeBook()
        let entry = chapterEntry(book: book)
        try await a.books.insertBook(book, chapters: [entry], now: t0)
        let mark = BookMark(
            bookId: book.id, chapterArticleId: entry.article.id, chapterIndex: 0, kind: .highlight,
            segmentOrder: 0, selectedText: "こんな夢", note: "记一笔", createdAt: t0, updatedAt: t0)
        try await a.books.saveMark(mark, now: t0)

        let pushed = try await a.content.pendingCloudPayloads(since: nil)
        let b = try makeDevice()
        _ = try await b.content.applyCloudPayloads(pushed, now: t1)
        let landed = try #require(try await b.books.marks(bookID: book.id).first)
        #expect(landed.note == "记一笔")
        #expect(landed.selectedText == "こんな夢")
        #expect(landed.chapterArticleId == entry.article.id)

        // A 删掉划线 → 墓碑 → B 也删掉，且不会被重新推回来
        try await a.books.deleteMark(id: mark.id, now: t1)
        let deletions = try await a.content.pendingCloudDeletions(since: nil)
        #expect(deletions.contains { $0.type == .bookMark && $0.id == mark.id.uuidString.lowercased() })
        try await b.content.applyCloudDeletions(deletions, now: t2)
        #expect(try await b.books.marks(bookID: book.id).isEmpty)
        // 墓碑挡住复活
        _ = try await b.content.applyCloudPayloads(pushed, now: t2)
        #expect(try await b.books.marks(bookID: book.id).isEmpty)
    }

    // MARK: - 删书的传播

    /// 删书前一个墓碑都不写，删除完全不传播 —— 对端下次同步又把整本书推回来。
    @Test func deletingABookPropagatesEverything() async throws {
        let a = try makeDevice()
        let book = makeBook()
        let entry = chapterEntry(book: book)
        try await a.books.insertBook(book, chapters: [entry], now: t0)
        try await a.content.replaceSegments(
            articleID: entry.article.id,
            segments: [
                ArticleSegment(articleId: entry.article.id, order: 0, text: "こんな夢を見た。", createdAt: t0)
            ], now: t0)
        try await a.books.saveMark(
            BookMark(bookId: book.id, chapterIndex: 0, kind: .bookmark, createdAt: t0), now: t0)

        let pushed = try await a.content.pendingCloudPayloads(since: nil)
        let b = try makeDevice()
        _ = try await b.content.applyCloudPayloads(pushed, now: t1)
        #expect(try await b.books.loadBooks().count == 1)

        try await a.books.deleteBook(id: book.id, now: t1)
        #expect(try await a.books.loadBooks().isEmpty)
        let deletions = try await a.content.pendingCloudDeletions(since: nil)
        #expect(deletions.contains { $0.type == .book && $0.id == book.id.uuidString.lowercased() })

        try await b.content.applyCloudDeletions(deletions, now: t2)
        #expect(try await b.books.loadBooks().isEmpty)
        // 章节 article、句子、划线全都跟着走（级联 + 显式删除）
        #expect(try await b.content.article(id: entry.article.id) == nil)
        #expect(try await b.content.loadSegments(articleID: entry.article.id).isEmpty)
        #expect(try await b.books.marks(bookID: book.id).isEmpty)
        // 章节 article 留了墓碑，别的设备不会把它推回来
        #expect(try await b.content.tombstoneIDs(for: .article).contains(entry.article.id.uuidString.lowercased()))
    }

    // MARK: - 文章去重不能误杀章节

    /// **同名同正文去重必须只对空正文生效。**
    ///
    /// 两台设备各自导入过同一本书时，章节的标题与正文当然一模一样。
    /// 无条件去重的话对端的章节文章会被全滤掉，而 `book_chapter` 行还指着
    /// 那些不存在的 article —— 撞外键，书库里留下**一本零章节的书**。
    @Test func chapterArticlesSurviveTheSampleDedup() async throws {
        let b = try makeDevice()
        let mine = makeBook()
        let myEntry = chapterEntry(book: mine)
        try await b.books.insertBook(mine, chapters: [myEntry], now: t0)

        // 另一台设备各自导入的同一本书：标题与正文完全相同，id 不同
        let theirs = makeBook()
        let theirEntry = chapterEntry(book: theirs)
        let applied = try await b.content.applyCloudPayloads(
            [
                try cloudPayload(.book, theirs.id, theirs),
                try cloudPayload(.article, theirEntry.article.id, theirEntry.article),
                try cloudPayload(.bookChapter, theirEntry.article.id, theirEntry.chapter),
            ], now: t1)

        #expect(applied == 3)
        #expect(try await b.books.loadBooks().count == 2)
        #expect(try await b.books.chapterSummaries(bookID: theirs.id).map(\.title) == ["第一夜"])
        // 两本都是完整的，没有零章节空壳
        #expect(try await b.books.chapterSummaries(bookID: mine.id).count == 1)
    }

    /// 但内置示例仍然要去重 —— 判据是 `content` 为空（正文在 segment 里）。
    @Test func emptyContentArticlesAreStillDeduped() async throws {
        let repo = try makeRepository()
        try await repo.insertArticle(
            Article(title: "夢十夜 第一夜（節選）", content: "", createdAt: t0), segments: [], now: t0)

        let theirs = Article(title: "夢十夜 第一夜（節選）", content: "", createdAt: t1)
        let applied = try await repo.applyCloudPayloads(
            [
                CloudPayload(
                    type: .article, id: theirs.id.uuidString.lowercased(),
                    data: try CloudRecord.encoder().encode(theirs), updatedAt: t1)
            ], now: t2)
        #expect(applied == 0)
        #expect(try await repo.loadAll().articles.count == 1)
    }

    /// 从书里划的生词：来源链接现在能保住了（章节文章也同步）。
    @Test func wordsCollectedFromBooksKeepTheirSourceLink() async throws {
        let a = try makeDevice()
        let book = makeBook()
        let entry = chapterEntry(book: book)
        try await a.books.insertBook(book, chapters: [entry], now: t0)

        var vocab = makeVocab(updatedAt: t0)
        vocab.sourceArticleId = entry.article.id
        vocab.sourceArticleTitle = "第一夜"
        try await a.content.insertFavorite(vocab, now: t0)

        let pushed = try await a.content.pendingCloudPayloads(since: nil)
        let b = try makeDevice()
        _ = try await b.content.applyCloudPayloads(pushed, now: t1)

        let landed = try #require(try await b.content.loadAll().favorites.first)
        #expect(landed.word == vocab.word)
        #expect(landed.sourceArticleId == entry.article.id)
        #expect(landed.sourceArticleTitle == "第一夜")
    }

    // MARK: - 合并云端变更

    @Test func newRecordFromCloudIsInserted() async throws {
        let repo = try makeRepository()
        let vocab = makeVocab(updatedAt: t0)
        let applied = try await repo.applyCloudPayloads([try payload(vocab)], now: t1)
        #expect(applied == 1)
        #expect(try await repo.loadAll().favorites.first?.word == "夢")
    }

    /// 与文件导入同一条规则：本地更新时间更晚就保留本地。
    @Test func localEditsAreNotOverwrittenByOlderCloudRecords() async throws {
        let repo = try makeRepository()
        let id = UUID()
        try await repo.insertFavorite(
            makeVocab(id: id, meaning: "本地改过的", updatedAt: t2), now: t2)

        _ = try await repo.applyCloudPayloads(
            [try payload(makeVocab(id: id, meaning: "云端旧的", updatedAt: t0))], now: t2)

        #expect(try await repo.loadAll().favorites.first?.meaning == "本地改过的")
    }

    /// 本地删过的记录不能被云端推回来。
    @Test func tombstonedRecordsAreNotResurrectedFromCloud() async throws {
        let repo = try makeRepository()
        let vocab = makeVocab(updatedAt: t0)
        try await repo.insertFavorite(vocab, now: t0)
        try await repo.deleteFavorite(id: vocab.id, now: t1)

        let applied = try await repo.applyCloudPayloads([try payload(vocab)], now: t2)
        #expect(applied == 0)
        #expect(try await repo.loadAll().favorites.isEmpty)
    }

    /// 云端的删除要在本地留墓碑，否则另一台设备下一轮又会把它推上来，
    /// 变成两台设备互相推、永远收敛不了。
    @Test func cloudDeletionsLeaveALocalTombstone() async throws {
        let repo = try makeRepository()
        let vocab = makeVocab(updatedAt: t0)
        try await repo.insertFavorite(vocab, now: t0)

        try await repo.applyCloudDeletions(
            [(type: .vocabulary, id: vocab.id.uuidString.lowercased())], now: t1)

        #expect(try await repo.loadAll().favorites.isEmpty)
        #expect(try await repo.tombstoneIDs(for: .favoriteVocabulary).count == 1)
    }

    /// 父文章不在本地的句子必须跳过 —— 外键会挡，硬写就是整批回滚，
    /// 一条孤儿句子会让整轮同步失败。
    @Test func orphanSegmentsDoNotAbortTheWholeMerge() async throws {
        let repo = try makeRepository()
        let orphan = ArticleSegment(articleId: UUID(), order: 0, text: "孤儿", createdAt: t0)
        let vocab = makeVocab(updatedAt: t0)

        let applied = try await repo.applyCloudPayloads(
            [
                CloudPayload(
                    type: .segment, id: orphan.id.uuidString.lowercased(),
                    data: try CloudRecord.encoder().encode(orphan), updatedAt: t0),
                try payload(vocab),
            ], now: t1)

        #expect(applied == 1)  // 只有生词进来了，整批没回滚
    }

    /// **本组测试里第二重要的一条**（仅次于复习重放）。
    ///
    /// `favorite_vocabulary.source_article_id` 是真外键。来源文章不在本机时，
    /// 这条生词曾经会撞 `FOREIGN KEY (787)` —— 而那时整批共用一个事务，
    /// **同一批里所有完好的生词跟着一起回滚**，CloudKit 的 change token 却照样前进，
    /// 于是这批记录再也不会被下发。用户那边看到的是"同步成功，但 Mac 上一个词都没有"。
    /// 实测就是这么丢的。
    @Test func vocabularyWithAMissingSourceArticleStillLands() async throws {
        let repo = try makeRepository()
        var vocab = makeVocab(updatedAt: t0)
        vocab.sourceArticleId = UUID()  // 本机没有这篇
        vocab.sourceArticleTitle = "夢十夜"
        vocab.sourceSegmentId = UUID()

        #expect(try await repo.applyCloudPayloads([try payload(vocab)], now: t1) == 1)

        let saved = try #require(try await repo.loadAll().favorites.first)
        #expect(saved.id == vocab.id)
        #expect(saved.word == vocab.word)
        // 断的只是跳回原文的链接；来源名字还在，界面上仍看得出它从哪来。
        #expect(saved.sourceArticleId == nil)
        #expect(saved.sourceSegmentId == nil)
        #expect(saved.sourceArticleTitle == "夢十夜")
    }

    /// 文章和它的生词在同一批里时，顺序不该由 CloudKit 的返回顺序决定 ——
    /// 先处理文章，来源链接就能当场接上，不用白丢一次。
    @Test func sourceLinkSurvivesWhenTheArticleIsInTheSameBatch() async throws {
        let repo = try makeRepository()
        let article = Article(title: "夢十夜", content: "こんな夢を見た。", createdAt: t0)
        var vocab = makeVocab(updatedAt: t0)
        vocab.sourceArticleId = article.id

        // 故意把生词排在文章前面：这正是出问题时的排列。
        let applied = try await repo.applyCloudPayloads(
            [
                try payload(vocab),
                CloudPayload(
                    type: .article, id: article.id.uuidString.lowercased(),
                    data: try CloudRecord.encoder().encode(article), updatedAt: t0),
            ], now: t1)

        #expect(applied == 2)
        #expect(try await repo.loadAll().favorites.first?.sourceArticleId == article.id)
    }

    /// 内置示例文章在旧版本里每台设备各自随机生成 id，同步过来就是两篇一模一样的。
    /// 每接入一台设备多两篇，很快就没法看了。
    @Test func identicalArticlesAreNotDuplicated() async throws {
        let repo = try makeRepository()
        try await repo.insertArticle(
            Article(title: "夢十夜 第一夜（節選）", content: "", createdAt: t0), segments: [], now: t0)

        // 另一台设备上同一篇示例，id 不同
        let theirs = Article(title: "夢十夜 第一夜（節選）", content: "", createdAt: t1)
        let applied = try await repo.applyCloudPayloads(
            [
                CloudPayload(
                    type: .article, id: theirs.id.uuidString.lowercased(),
                    data: try CloudRecord.encoder().encode(theirs), updatedAt: t1)
            ], now: t2)

        #expect(applied == 0)
        #expect(try await repo.loadAll().articles.count == 1)
    }

    /// 但同名不同正文是**两篇不同的文章**，不能误杀。
    @Test func sameTitleDifferentBodyIsStillANewArticle() async throws {
        let repo = try makeRepository()
        try await repo.insertArticle(
            Article(title: "读书笔记", content: "第一版", createdAt: t0), segments: [], now: t0)

        let theirs = Article(title: "读书笔记", content: "完全不同的正文", createdAt: t1)
        let applied = try await repo.applyCloudPayloads(
            [
                CloudPayload(
                    type: .article, id: theirs.id.uuidString.lowercased(),
                    data: try CloudRecord.encoder().encode(theirs), updatedAt: t1)
            ], now: t2)

        #expect(applied == 1)
        #expect(try await repo.loadAll().articles.count == 2)
    }

    /// 撞了唯一约束的那一条自己滚回去就行，不能连累同批的其它记录。
    @Test func oneConstraintViolationDoesNotTakeDownTheBatch() async throws {
        let repo = try makeRepository()
        let article = Article(title: "夢十夜", content: "こんな夢を見た。", createdAt: t0)
        try await repo.insertArticle(article, segments: [], now: t0)

        // 本机已有「夢@这篇文章」。UNIQUE(normalized_word, source_article_id)
        // 会挡住另一个 id、同词同来源的记录 —— 两台设备在同步前各收藏过一次就是这样。
        var mine = makeVocab(updatedAt: t0)
        mine.sourceArticleId = article.id
        try await repo.insertFavorite(mine, now: t0)

        var clash = makeVocab(id: UUID(), word: "夢", updatedAt: t2)
        clash.sourceArticleId = article.id
        let innocent = makeVocab(id: UUID(), word: "空", updatedAt: t2)

        let applied = try await repo.applyCloudPayloads(
            [try payload(clash), try payload(innocent)], now: t2)

        // 同词同来源现在按同步协议 §9 合并（本机那张更早，留下；远端那张记成被合并），
        // 不再撞 UNIQUE —— 两条都算"处理掉了"，停放表里什么都不剩。
        #expect(applied == 2)
        let favorites = try await repo.loadAll().favorites
        #expect(Set(favorites.map(\.word)) == ["夢", "空"])  // 原有的没被冲掉，无辜的那条进来了
        #expect(favorites.contains { $0.id == mine.id })
        #expect(!favorites.contains { $0.id == clash.id })
        #expect(try await repo.pendingCloudPayloadCount() == 0)
    }

    // MARK: - 复习进度：绝不 LWW

    /// **本组测试里最重要的一条。**
    ///
    /// A、B 两台设备各离线复习同一张卡一轮。若卡片状态按 `updated_at` 后写胜，
    /// 晚同步的那台会整轮覆盖掉另一台 —— 用户复习了两次、进度只记了一次。
    /// 正确做法是同步事件（只增不删），再重放算出卡片状态。
    @Test func twoOfflineReviewsBothSurviveTheMerge() async throws {
        let repo = try makeRepository()
        let vocab = makeVocab(updatedAt: t0)
        try await repo.insertFavorite(vocab, now: t0)

        func event(at: Date) -> ReviewEvent {
            ReviewEvent(
                vocabularyId: vocab.id, reviewedAt: at, dateLocal: "2026-01-01", grade: 3,
                elapsedDays: 0, previousState: .new, schedulerVersion: "fsrs6",
                desiredRetention: 0.9, resultStability: 1, resultDifficulty: 5,
                resultIntervalDays: 1, resultState: .review)
        }
        let deviceA = event(at: t0)
        let deviceB = event(at: t0.addingTimeInterval(2 * 24 * 3600))

        _ = try await repo.applyCloudPayloads(
            [deviceA, deviceB].map {
                CloudPayload(
                    type: .reviewEvent, id: $0.id.uuidString.lowercased(),
                    data: try! CloudRecord.encoder().encode($0), updatedAt: $0.reviewedAt)
            }, now: t2)

        let card = try #require(try await repo.loadAll().favorites.first)
        // 两轮都被计入，而不是只剩一轮
        #expect(card.reviewCount == 2)
        #expect(card.stability > 0)
        #expect(card.srsState == .review)
    }

    /// 复习事件是 append-only，重复同步同一条不能产生第二行。
    @Test func repeatedReviewEventsAreDeduplicated() async throws {
        let repo = try makeRepository()
        let vocab = makeVocab(updatedAt: t0)
        try await repo.insertFavorite(vocab, now: t0)
        let event = ReviewEvent(
            vocabularyId: vocab.id, reviewedAt: t0, dateLocal: "2026-01-01", grade: 3,
            elapsedDays: 0, previousState: .new, schedulerVersion: "fsrs6",
            desiredRetention: 0.9, resultStability: 1, resultDifficulty: 5,
            resultIntervalDays: 1, resultState: .review)
        let cloud = CloudPayload(
            type: .reviewEvent, id: event.id.uuidString.lowercased(),
            data: try CloudRecord.encoder().encode(event), updatedAt: t0)

        _ = try await repo.applyCloudPayloads([cloud], now: t1)
        _ = try await repo.applyCloudPayloads([cloud], now: t1)

        let count = try await repo.database.writer.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM review_log") ?? -1
        }
        #expect(count == 1)
    }

    // MARK: - 导入与同步的联动

    /// 导入刻意保留了来源端的 `updatedAt`，那些时间戳可能比水位线还旧。
    /// 不回拨水位线的话，刚导进来的几百个词**永远上不了云**，其它设备完全看不见。
    @Test func importRewindsTheWatermarkSoImportedDataStillGetsPushed() async throws {
        let repo = try makeRepository()
        try await repo.setSyncWatermark(t2)

        // 文件里是很旧的记录
        let old = makeVocab(updatedAt: t0)
        let bundle = TransferBundle(exportedAt: t0, vocabulary: [old])
        let result = try await repo.importTransferBundle(bundle, now: t2)
        #expect(result.vocabulary.inserted == 1)

        #expect(try await repo.syncWatermark() == nil)
        // 水位线归零后，这条旧记录才会被收集去推送
        let payloads = try await repo.pendingCloudPayloads(since: nil)
        #expect(payloads.contains { $0.type == .vocabulary })
    }

    /// 什么都没导进来时不该白白触发一次全量重推。
    @Test func aNoOpImportLeavesTheWatermarkAlone() async throws {
        let repo = try makeRepository()
        try await repo.setSyncWatermark(t2)
        _ = try await repo.importTransferBundle(TransferBundle(exportedAt: t0), now: t2)
        #expect(try await repo.syncWatermark() == t2)
    }

    // MARK: - 引擎状态

    @Test func syncStateRoundTrips() async throws {
        let repo = try makeRepository()
        #expect(try await repo.syncEngineState() == nil)
        #expect(try await repo.syncWatermark() == nil)

        try await repo.setSyncEngineState(Data([1, 2, 3]))
        try await repo.setSyncWatermark(t1)
        #expect(try await repo.syncEngineState() == Data([1, 2, 3]))
        #expect(try await repo.syncWatermark() == t1)

        // 两个字段互不干扰（单行表读改写最容易在这里出错）
        try await repo.setSyncWatermark(t2)
        #expect(try await repo.syncEngineState() == Data([1, 2, 3]))
    }

    // MARK: - change tag（记录元信息）

    /// CloudKit 的保存是 compare-and-swap：请求里必须带上上次见到的 change tag。
    /// 每次现造一条空 `CKRecord` 的话没有 tag，服务端一律当成"新建"，于是
    /// **任何一条已在云上的记录再推一次都会回 `serverRecordChanged`**。
    /// 加上水位线有 5 秒重叠，同步跑第二次就必炸 —— 实测就是这么炸的。
    @Test func systemFieldsSurviveTheRoundTrip() throws {
        let recordID = CKRecord.ID(
            recordName: CloudRecord.recordName(.vocabulary, UUID().uuidString),
            zoneID: CKRecordZone.ID(zoneName: "OpenKotoZone", ownerName: CKCurrentUserDefaultName))
        let record = CKRecord(recordType: CloudRecordType.vocabulary.rawValue, recordID: recordID)
        record[CloudRecord.payloadKey] = Data([1, 2, 3]) as CKRecordValue

        let restored = try #require(
            CloudRecord.decodeSystemFields(CloudRecord.encodeSystemFields(record)))
        #expect(restored.recordID == recordID)
        #expect(restored.recordType == record.recordType)
        // 只存系统字段：业务字段不跟着走，payload 每次都从本地库现编，
        // 免得同一份数据在两处各存一份然后慢慢对不上。
        #expect(restored[CloudRecord.payloadKey] == nil)
    }

    @Test func corruptSystemFieldsDecodeToNilInsteadOfCrashing() {
        #expect(CloudRecord.decodeSystemFields(Data([0xde, 0xad, 0xbe, 0xef])) == nil)
    }

    @Test func recordMetaRoundTrips() async throws {
        let repo = try makeRepository()
        #expect(try await repo.cloudRecordMeta().isEmpty)

        let name = CloudRecord.recordName(.vocabulary, UUID().uuidString)
        try await repo.saveCloudRecordMeta([
            CloudRecordMeta(
                recordName: name, systemFields: Data([9]), payloadHash: "abc", syncedAt: t1)
        ])
        #expect(try await repo.cloudRecordMeta()[name]?.payloadHash == "abc")

        // 同一条再存一次是覆盖，不是插重复（主键冲突会直接抛错）
        try await repo.saveCloudRecordMeta([
            CloudRecordMeta(
                recordName: name, systemFields: Data([9]), payloadHash: "def", syncedAt: t2)
        ])
        let meta = try await repo.cloudRecordMeta()
        #expect(meta.count == 1)
        #expect(meta[name]?.payloadHash == "def")

        try await repo.deleteCloudRecordMeta(recordNames: [name])
        #expect(try await repo.cloudRecordMeta().isEmpty)
    }

    // MARK: - 回声抑制

    /// 从云端拉回来的记录一落库，`updated_at` 就越过了水位线，
    /// 下一轮扫描会把它原封不动推回去。内容哈希一致就该直接跳过。
    @Test func unchangedPayloadsAreNotPushedBack() throws {
        let vocab = makeVocab(updatedAt: t1)
        let one = try payload(vocab)
        let name = CloudRecord.recordName(one.type, one.id)

        #expect(CloudRecord.changedPayloads([one], knownHashes: [:]).count == 1)
        #expect(
            CloudRecord.changedPayloads(
                [one], knownHashes: [name: CloudRecord.hash(one.data)]
            ).isEmpty)
    }

    /// 内容真的变了就必须推 —— 滤错方向是静默丢数据，比多推一次严重得多。
    @Test func editedPayloadsStillGetPushed() throws {
        let id = UUID()
        let before = try payload(makeVocab(id: id, meaning: "梦", updatedAt: t1))
        let after = try payload(makeVocab(id: id, meaning: "梦想", updatedAt: t2))
        let name = CloudRecord.recordName(after.type, after.id)

        let changed = CloudRecord.changedPayloads(
            [after], knownHashes: [name: CloudRecord.hash(before.data)])
        #expect(changed[name]?.updatedAt == t2)
    }

    /// 哈希只按记录名比对，不能张冠李戴。
    @Test func hashesAreMatchedPerRecord() throws {
        let a = try payload(makeVocab(word: "夢", updatedAt: t1))
        let b = try payload(makeVocab(word: "空", updatedAt: t1))
        let changed = CloudRecord.changedPayloads(
            [a, b],
            knownHashes: [CloudRecord.recordName(a.type, a.id): CloudRecord.hash(a.data)])
        #expect(changed.count == 1)
        #expect(changed[CloudRecord.recordName(b.type, b.id)] != nil)
    }
}
