import Foundation
import OKModels
import Testing

@testable import OKAccount
@testable import OKCommerce
@testable import OKPersistence

/// 协议 §4.2 / §4.3：删文章时它的 Segment / LyricsMeta / BookChapter 要写墓碑；
/// 重新切分时旧句子要写墓碑。歌词元数据走 OpenKoto 云。
@Suite struct ChildTombstoneTests {
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    private func makeEngine(_ cloud: FakeCloud) throws -> (HTTPSyncEngine, ContentRepository) {
        let repository = try ContentRepository(database: AppDatabase.inMemory())
        return (HTTPSyncEngine(repository: repository, transport: HTTPSyncTransport(api: cloud.client())), repository)
    }

    private func sync(_ engine: HTTPSyncEngine) async throws {
        try await engine.pull()
        try await engine.push()
    }

    private func segments(_ article: Article, _ texts: [String]) -> [ArticleSegment] {
        texts.enumerated().map {
            ArticleSegment(articleId: article.id, order: $0.offset, text: $0.element, createdAt: t0)
        }
    }

    @Test func deletingAnArticleTombstonesItsChildren() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        let article = Article(title: "歌", content: "a\nb", sourceType: .lyrics, createdAt: t0)
        let lines = segments(article, ["a", "b"])
        try await repo.insertArticle(article, segments: lines, now: t0)
        try await repo.saveLyricsMeta(LyricsMeta(articleId: article.id, artist: "X"), now: t0)
        try await sync(engine)
        #expect(cloud.record("LyricsMeta", article.id.uuidString)?.payload?["artist"] == .string("X"))
        #expect(cloud.records.values.filter { $0.type == "Segment" }.count == 2)

        try await repo.deleteArticle(id: article.id, now: Date())
        try await sync(engine)

        #expect(cloud.record("Article", article.id.uuidString)?.deleted == true)
        #expect(cloud.record("LyricsMeta", article.id.uuidString)?.deleted == true)
        for line in lines {
            #expect(cloud.record("Segment", line.id.uuidString)?.deleted == true)
        }
        let pushes = cloud.pushRequests.count
        try await sync(engine)
        #expect(cloud.pushRequests.count == pushes, "推过的墓碑不再重推")
    }

    @Test func resegmentingTombstonesTheOldSegments() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        let article = Article(title: "文", content: "一。二。", createdAt: t0)
        let old = segments(article, ["一。二。"])
        try await repo.insertArticle(article, segments: old, now: t0)
        try await sync(engine)

        let new = segments(article, ["一。", "二。"])
        try await repo.replaceSegments(articleID: article.id, segments: new)
        try await sync(engine)

        #expect(cloud.record("Segment", old[0].id.uuidString)?.deleted == true)
        #expect(new.allSatisfy { cloud.record("Segment", $0.id.uuidString)?.deleted == false })

        // 另一台设备照此收敛：旧句子被删、新句子进来，不撞 (article_id, order) 唯一约束
        let (engine2, repo2) = try makeEngine(cloud)
        try await engine2.pull()
        #expect(try await repo2.loadSegments(articleID: article.id).map(\.text) == ["一。", "二。"])
        #expect(try await repo2.pendingCloudPayloadCount() == 0)
    }

    /// 父文章压根没进本机的句子（这里：一直停放着）不能被当成"本地删掉了"。
    @Test func parkedSegmentsAreNotTombstoned() async throws {
        let cloud = FakeCloud()
        let (engine, _) = try makeEngine(cloud)
        let orphanArticle = UUID()
        let segment = ArticleSegment(articleId: orphanArticle, order: 0, text: "x", createdAt: t0)
        cloud.write(
            type: "Segment", id: segment.id.uuidString, hlc: "1790000000000-0000-bbbbbbbb",
            payload: try JSONValue(jsonData: try CloudRecord.encoder().encode(segment)))
        try await sync(engine)
        #expect(cloud.record("Segment", segment.id.uuidString)?.deleted == false)
        #expect(cloud.pushRequests.flatMap(\.ops).isEmpty)
    }

    @Test func lyricsFromTheWebArriveWithTheirMeta() async throws {
        let cloud = FakeCloud()
        let (engine, repo) = try makeEngine(cloud)
        let id = UUID().uuidString.lowercased()
        let line = UUID().uuidString.lowercased()
        cloud.write(type: "Article", id: id, hlc: "1790000000000-0000-cccccccc", payload: .object([
            "id": .string(id), "title": .string("Song"), "content": .string("[00:12.50]hello"),
            "sourceType": .string("lyrics"), "createdAt": .string("2026-09-28T10:00:00.000Z"),
        ]))
        cloud.write(type: "LyricsMeta", id: id, hlc: "1790000000000-0001-cccccccc", payload: .object([
            "articleId": .string(id), "artist": .string("Singer"), "sourceFormat": .string("lrc"),
        ]))
        cloud.write(type: "Segment", id: line, hlc: "1790000000000-0002-cccccccc", payload: .object([
            "id": .string(line), "articleId": .string(id), "order": .int(0), "text": .string("hello"),
            "isNewParagraph": .bool(false), "startTime": .double(12.5), "endTime": .null,
            "createdAt": .string("2026-09-28T10:00:00.000Z"),
        ]))
        try await engine.pull()
        let articleID = try #require(UUID(uuidString: id))
        #expect(try await repo.article(id: articleID)?.sourceType == .lyrics)
        #expect(try await repo.loadLyricsMeta()[articleID]?.artist == "Singer")
        #expect(try await repo.loadSegments(articleID: articleID).first?.startTime == 12.5)
        try await engine.push()
        #expect(cloud.pushRequests.flatMap(\.ops).isEmpty, "拉下来的原样不推回")
    }
}

/// StoreKit 购买的服务端核验请求与 appAccountToken。
@Suite struct CommerceTests {
    @Test func appAccountTokenUsesTheUserIDWhenItIsAUUID() {
        let id = "3F0C2A4E-1D2B-4C5D-9E8F-0A1B2C3D4E5F"
        #expect(AppAccountToken.forUser(id.lowercased()) == UUID(uuidString: id))
        let derived = AppAccountToken.forUser("user_abc")
        #expect(derived == AppAccountToken.forUser("user_abc"), "非 UUID 的 id 派生结果必须稳定")
        #expect(derived.uuidString.lowercased().dropFirst(14).first == "5", "版本位")
    }

    @Test func productIDsMatchTheCatalog() {
        #expect(CommerceProduct.allIDs == [
            "com.openkoto.plus.month", "com.openkoto.plus.year", "com.openkoto.pro.month",
            "com.openkoto.pro.year", "com.openkoto.credits.3000",
        ])
        #expect(!CommerceProduct.credits3000.isSubscription)
    }

    @Test func verifierPostsTheJWSWithTheBearerToken() async throws {
        let cloud = FakeCloud()
        let verifier = PurchaseVerifier(api: cloud.client())
        let token = UUID()
        _ = try? await verifier.verify(jws: "eyJ.jws.sig", productID: "com.openkoto.plus.month", transactionID: "42", appAccountToken: token)
        let request = try #require(cloud.log.last)
        #expect(request.method == "POST")
        #expect(request.path == "/api/v1/billing/appstore/verify")
        #expect(request.headers["Authorization"] == "Bearer access-1")
        let body = try JSONDecoder().decode(PurchaseVerifier.Request.self, from: try #require(request.body))
        #expect(body.signedTransaction == "eyJ.jws.sig")
        #expect(body.appAccountToken == token.uuidString.lowercased())
    }

    @Test func storeKitConfigurationListsEveryProduct() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "OpenKoto.storekit")
        let text = try String(contentsOf: url, encoding: .utf8)
        for id in CommerceProduct.allIDs { #expect(text.contains("\"\(id)\"")) }
    }
}

