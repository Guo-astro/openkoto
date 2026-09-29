import Foundation
import GRDB

/// 一条 OpenKoto 云记录"上次同步成功时的样子"（migration v12）。
public struct HTTPSyncMeta: Codable, FetchableRecord, PersistableRecord, Sendable, Equatable {
    public static let databaseTableName = "http_sync_meta"

    /// `类型_主键`（同 `CloudRecord.recordName`，主键小写）。
    public var recordName: String
    public var rev: Int64
    public var hlc: String?
    public var payloadHash: String?
    public var deleted: Bool
    public var syncedAt: Date
    /// 子记录（Segment / BookChapter / LyricsMeta）的父文章 id（migration v13）。
    /// 用来判断"本地没了"到底是被删 / 被重新切分，还是父记录压根没进本机。
    public var parentId: String?

    public enum CodingKeys: String, CodingKey {
        case recordName = "record_name"
        case rev, hlc
        case payloadHash = "payload_hash"
        case deleted
        case syncedAt = "synced_at"
        case parentId = "parent_id"
    }

    public init(
        recordName: String, rev: Int64, hlc: String?, payloadHash: String?, deleted: Bool,
        syncedAt: Date
    ) {
        self.recordName = recordName
        self.rev = rev
        self.hlc = hlc
        self.payloadHash = payloadHash
        self.deleted = deleted
        self.syncedAt = syncedAt
        self.parentId = nil
    }
}

/// HTTP 引擎在 `sync_state` 里的那几列。
public struct HTTPSyncStateSnapshot: Sendable, Equatable {
    public var cursor: String?
    public var watermark: Date?
    public var clock: String?
    public var account: String?

    public init(cursor: String? = nil, watermark: Date? = nil, clock: String? = nil, account: String? = nil) {
        self.cursor = cursor
        self.watermark = watermark
        self.clock = clock
        self.account = account
    }
}

extension ContentRepository {
    private static func ensureSyncStateRow(_ db: Database) throws {
        try db.execute(
            sql: "INSERT OR IGNORE INTO sync_state (id) VALUES (?)",
            arguments: [SyncStateRecord.singletonID])
    }

    public func httpSyncState() async throws -> HTTPSyncStateSnapshot {
        try await database.writer.read { db in
            guard
                let row = try Row.fetchOne(
                    db,
                    sql: """
                        SELECT http_cursor, http_watermark, http_clock, http_account
                        FROM sync_state WHERE id = ?
                        """,
                    arguments: [SyncStateRecord.singletonID])
            else { return HTTPSyncStateSnapshot() }
            return HTTPSyncStateSnapshot(
                cursor: row["http_cursor"], watermark: row["http_watermark"],
                clock: row["http_clock"], account: row["http_account"])
        }
    }

    public func setHTTPSyncCursor(_ cursor: String?) async throws {
        try await database.writer.write { db in
            try Self.ensureSyncStateRow(db)
            try db.execute(
                sql: "UPDATE sync_state SET http_cursor = ? WHERE id = ?",
                arguments: [cursor, SyncStateRecord.singletonID])
        }
    }

    public func setHTTPSyncWatermark(_ date: Date?) async throws {
        try await database.writer.write { db in
            try Self.ensureSyncStateRow(db)
            try db.execute(
                sql: "UPDATE sync_state SET http_watermark = ? WHERE id = ?",
                arguments: [date, SyncStateRecord.singletonID])
        }
    }

    public func setHTTPSyncClock(_ clock: String?) async throws {
        try await database.writer.write { db in
            try Self.ensureSyncStateRow(db)
            try db.execute(
                sql: "UPDATE sync_state SET http_clock = ? WHERE id = ?",
                arguments: [clock, SyncStateRecord.singletonID])
        }
    }

    /// 清空 HTTP 同步的全部进度（游标、水位线、逐条元数据），并记下新的归属账号。
    /// **不碰任何本地数据**：下一次同步会全量拉一遍、再把本地全部推一遍。
    public func resetHTTPSyncState(account: String?) async throws {
        try await database.writer.write { db in
            try Self.ensureSyncStateRow(db)
            try db.execute(
                sql: """
                    UPDATE sync_state SET http_cursor = NULL, http_watermark = NULL,
                    http_account = ? WHERE id = ?
                    """,
                arguments: [account, SyncStateRecord.singletonID])
            _ = try HTTPSyncMeta.deleteAll(db)
        }
    }

    public func httpSyncMeta() async throws -> [String: HTTPSyncMeta] {
        try await database.writer.read { db in
            let rows = try HTTPSyncMeta.fetchAll(db)
            return Dictionary(rows.map { ($0.recordName, $0) }, uniquingKeysWith: { _, last in last })
        }
    }

    /// 指定记录名的元数据（一页 pull 用，免得每页都把整张表读进内存）。
    public func httpSyncMeta(names: [String]) async throws -> [String: HTTPSyncMeta] {
        guard !names.isEmpty else { return [:] }
        return try await database.writer.read { db in
            var result: [String: HTTPSyncMeta] = [:]
            for chunk in stride(from: 0, to: names.count, by: 500) {
                let slice = Array(names[chunk..<min(chunk + 500, names.count)])
                for row in try HTTPSyncMeta.filter(keys: slice).fetchAll(db) {
                    result[row.recordName] = row
                }
            }
            return result
        }
    }

    public func saveHTTPSyncMeta(_ rows: [HTTPSyncMeta]) async throws {
        guard !rows.isEmpty else { return }
        try await database.writer.write { db in
            for row in rows { try row.save(db) }
        }
    }

    /// 云上还活着、本地却已经没有的子记录（Segment / BookChapter / LyricsMeta）。
    ///
    /// 只认两种"本地没了"：父文章还在（重新切分换掉了旧句子）或父文章有本地墓碑（被删了）。
    /// 父文章压根没进本机的（示例文章去重、还停在 `pending_cloud_payload` 里等依赖）
    /// 一律不算 —— 给它们推墓碑等于把别的设备的内容删掉。
    public func orphanedChildRecords() async throws -> [(type: CloudRecordType, id: String)] {
        try await database.writer.read { db in
            let checks: [(CloudRecordType, String, String)] = [
                (.segment, "segment", "id"),
                (.bookChapter, "book_chapter", "article_id"),
                (.lyricsMeta, "lyrics_meta", "article_id"),
            ]
            var result: [(type: CloudRecordType, id: String)] = []
            for (type, table, key) in checks {
                let prefix = "\(type.rawValue)_"
                let ids = try String.fetchAll(
                    db,
                    sql: """
                        SELECT substr(m.record_name, ?) FROM http_sync_meta m
                        WHERE m.record_name LIKE ? AND m.deleted = 0
                          AND NOT EXISTS (SELECT 1 FROM \(table) t
                                          WHERE t.\(key) = substr(m.record_name, ?))
                          AND NOT EXISTS (SELECT 1 FROM pending_cloud_payload p
                                          WHERE p.record_name = m.record_name)
                          AND (EXISTS (SELECT 1 FROM article a WHERE a.id = m.parent_id)
                               OR EXISTS (SELECT 1 FROM deleted_record d
                                          WHERE d.table_name = 'article'
                                            AND d.record_id = m.parent_id))
                        """,
                    arguments: [prefix.count + 1, prefix + "%", prefix.count + 1])
                result += ids.map { (type, $0) }
            }
            return result
        }
    }
}
