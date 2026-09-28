import Foundation
import GRDB
import OKModels

/// `lyrics_meta` 行（migration v13）。主键 = 歌词文章 id，随文章级联删除。
struct LyricsMetaRecord: Codable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "lyrics_meta"

    var articleId: String
    var artist: String?
    var album: String?
    var language: String?
    var lrcOffsetMs: Int?
    var sourceFormat: String?
    var coverUrl: String?
    /// JSON 数组。
    var musicLinks: String?
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case articleId = "article_id"
        case artist, album, language
        case lrcOffsetMs = "lrc_offset_ms"
        case sourceFormat = "source_format"
        case coverUrl = "cover_url"
        case musicLinks = "music_links"
        case updatedAt = "updated_at"
    }

    init(_ meta: LyricsMeta, updatedAt: Date) {
        articleId = uuidString(meta.articleId)
        artist = meta.artist
        album = meta.album
        language = meta.language
        lrcOffsetMs = meta.lrcOffsetMs
        sourceFormat = meta.sourceFormat?.rawValue
        coverUrl = meta.coverUrl
        musicLinks = meta.musicLinks.flatMap { try? JSONEncoder().encode($0) }
            .flatMap { String(data: $0, encoding: .utf8) }
        self.updatedAt = updatedAt
    }

    func domainModel() throws -> LyricsMeta {
        LyricsMeta(
            articleId: try parseUUID(articleId, table: Self.databaseTableName),
            artist: artist, album: album, language: language, lrcOffsetMs: lrcOffsetMs,
            sourceFormat: sourceFormat.flatMap(LyricsSourceFormat.init(rawValue:)),
            coverUrl: coverUrl,
            musicLinks: musicLinks.flatMap { try? JSONDecoder().decode([String].self, from: Data($0.utf8)) })
    }
}

extension ContentRepository {
    /// 全部歌词元数据（书库卡片显示歌手用）。
    public func loadLyricsMeta() async throws -> [UUID: LyricsMeta] {
        try await database.writer.read { db in
            var result: [UUID: LyricsMeta] = [:]
            for record in try LyricsMetaRecord.fetchAll(db) {
                if let meta = try? record.domainModel() { result[meta.articleId] = meta }
            }
            return result
        }
    }

    public func saveLyricsMeta(_ meta: LyricsMeta, now: Date = .now) async throws {
        try await database.writer.write { db in
            try LyricsMetaRecord(meta, updatedAt: now).save(db)
        }
    }
}
