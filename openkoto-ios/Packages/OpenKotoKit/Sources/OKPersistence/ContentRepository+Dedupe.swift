import CryptoKit
import Foundation
import GRDB
import OKModels

/// 同一个词在两台设备上各建了一张卡（id 不同）时的合并（同步协议 §9 / SRS 规范 §1.4）。
///
/// 口径沿用 iOS 的唯一键 `(normalized_word, source_article_id)`（NULL 视为相等）：
/// 这正是远端卡片直接插入会撞 UNIQUE 约束的情形 —— 不合并的话那张卡会在停放表里
/// 反复失败、30 天后被丢弃。跨来源文章的同词卡片在 iOS 上本来就允许并存，不合并。
///
/// 规则：
/// - 保留 `createdAt` 较早的一张（相同时取 id 较小的），另一张是"被合并方"；
/// - 被合并方的每条有效复习事件，**复制一条指向保留卡**，并给原事件追加撤销标记；
///   复制与标记的 id 都由 (原事件 id, 保留卡 id) 确定性派生 —— 两台设备各自做同一次
///   合并时得到**同样的 id**，服务端按"只追加、同 id 幂等"收下，不会重复计数；
/// - 词包成员并入保留卡；被合并方删掉并记墓碑（随后推成 Vocabulary 墓碑）；
/// - 记下映射 `merged_vocabulary`：被合并方的事件 / 成员关系晚些才到时照样改指过去。
extension ContentRepository {
    struct MergedVocabularyRecord: Codable, FetchableRecord, PersistableRecord {
        static let databaseTableName = "merged_vocabulary"
        var loserId: String
        var keeperId: String
        var mergedAt: Date

        enum CodingKeys: String, CodingKey {
            case loserId = "loser_id"
            case keeperId = "keeper_id"
            case mergedAt = "merged_at"
        }
    }

    /// 被合并过的卡 → 保留卡。
    static func keeperID(forMerged vocabularyID: String, _ db: Database) throws -> String? {
        try MergedVocabularyRecord.fetchOne(db, key: vocabularyID)?.keeperId
    }

    /// 本地与远端卡片 `incoming` 同词同来源、但 id 不同的那张。
    static func duplicateLocalCard(
        of incoming: FavoriteVocabularyRecord, _ db: Database
    ) throws -> FavoriteVocabularyRecord? {
        var request = FavoriteVocabularyRecord
            .filter(Column("normalized_word") == incoming.normalizedWord)
            .filter(Column("id") != incoming.id)
        if let source = incoming.sourceArticleId {
            request = request.filter(Column("source_article_id") == source)
        } else {
            request = request.filter(Column("source_article_id") == nil)
        }
        return try request.fetchOne(db)
    }

    /// 两张卡谁留下：`createdAt` 早者，平局取 id 小者。
    static func keeps(_ a: FavoriteVocabularyRecord, over b: FavoriteVocabularyRecord) -> Bool {
        a.createdAt == b.createdAt ? a.id < b.id : a.createdAt < b.createdAt
    }

    /// 把 `loser` 并入 `keeper`。`loser` 可能根本不在本机（远端那张被判输时）。
    static func mergeVocabulary(
        loser: String, into keeper: String, _ db: Database, now: Date,
        touched: inout Set<String>
    ) throws {
        try MergedVocabularyRecord(loserId: loser, keeperId: keeper, mergedAt: now).save(db)
        for event in try ReviewLogRecord.filter(Column("vocabulary_id") == loser).fetchAll(db) {
            try repointEvent(event, to: keeper, db)
        }
        // 词包成员并过去（重复的忽略），然后删卡、记墓碑。
        try db.execute(
            sql: """
                INSERT OR IGNORE INTO word_pack_membership (vocabulary_id, pack_id, created_at)
                SELECT ?, pack_id, ? FROM word_pack_membership
                WHERE vocabulary_id = ? AND pack_id IN (SELECT id FROM word_pack)
                """,
            // created_at 取"现在"：成员关系按 created_at 扫水位线，沿用旧时间就推不上去。
            arguments: [keeper, now, loser])
        _ = try FavoriteVocabularyRecord.deleteOne(db, key: loser)
        try TombstoneRecord.mark(db, table: .favoriteVocabulary, recordID: loser, at: now)
        touched.insert(keeper)
    }

    /// 被合并方的一条事件：复制一条指向保留卡 + 给原事件记撤销标记（都幂等）。
    static func repointEvent(_ event: ReviewLogRecord, to keeper: String, _ db: Database) throws {
        // 撤销标记本身、以及已经是复制品的，不再复制。
        guard event.voidsEventId == nil, event.vocabularyId != keeper else { return }
        let copyID = derivedID("copy", event.id, keeper)
        if try ReviewLogRecord.fetchOne(db, key: copyID) == nil {
            var copy = event
            copy.id = copyID
            copy.vocabularyId = keeper
            copy.hlc = nil
            try copy.insert(db)
        }
        let markerID = derivedID("void", event.id, keeper)
        if try ReviewLogRecord.fetchOne(db, key: markerID) == nil {
            var marker = event
            marker.id = markerID
            marker.grade = 0
            marker.voidsEventId = event.id
            marker.hlc = nil
            try marker.insert(db)
        }
    }

    /// 由内容派生的 UUID（v5 风格位标记），小写字符串。
    static func derivedID(_ kind: String, _ eventID: String, _ keeperID: String) -> String {
        var bytes = Array(
            SHA256.hash(data: Data("openkoto.dedupe.\(kind):\(eventID.lowercased()):\(keeperID.lowercased())".utf8))
                .prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        let uuid = UUID(
            uuid: (
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
            ))
        return uuidString(uuid)
    }
}
