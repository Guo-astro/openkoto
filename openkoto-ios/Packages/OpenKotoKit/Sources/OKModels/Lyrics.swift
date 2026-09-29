import Foundation

/// 歌词原始格式。
public enum LyricsSourceFormat: String, Codable, Sendable, CaseIterable {
    case lrc
    case txt
    case srt

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = LyricsSourceFormat(rawValue: raw) ?? .txt
    }
}

/// 歌词的附加信息（同步协议 §2.2 `LyricsMeta`；与 `packages/core` 的 `LyricsMeta` 对应）。
///
/// 歌词本体就是一篇 `sourceType == .lyrics` 的 `Article`，每行一个 `ArticleSegment`
/// （`startTime` 是该行的时间戳，秒）。这里只放不属于文章的元数据，主键 = articleId。
/// **不存音频**：`musicLinks` 只是外部链接。
public struct LyricsMeta: Codable, Sendable, Hashable, Identifiable {
    public var articleId: UUID
    public var artist: String?
    public var album: String?
    public var language: String?
    /// 整体时间偏移（毫秒，LRC 的 `[offset:]`）。
    public var lrcOffsetMs: Int?
    public var sourceFormat: LyricsSourceFormat?
    public var coverUrl: String?
    public var musicLinks: [String]?

    public var id: UUID { articleId }

    public init(
        articleId: UUID, artist: String? = nil, album: String? = nil, language: String? = nil,
        lrcOffsetMs: Int? = nil, sourceFormat: LyricsSourceFormat? = nil, coverUrl: String? = nil,
        musicLinks: [String]? = nil
    ) {
        self.articleId = articleId
        self.artist = artist
        self.album = album
        self.language = language
        self.lrcOffsetMs = lrcOffsetMs
        self.sourceFormat = sourceFormat
        self.coverUrl = coverUrl
        self.musicLinks = musicLinks
    }

    enum CodingKeys: String, CodingKey {
        case articleId, artist, album, language, lrcOffsetMs, sourceFormat, coverUrl, musicLinks
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            articleId: try c.decode(UUID.self, forKey: .articleId),
            artist: c.lenient(String.self, .artist),
            album: c.lenient(String.self, .album),
            language: c.lenient(String.self, .language),
            lrcOffsetMs: c.lenient(Int.self, .lrcOffsetMs),
            sourceFormat: c.lenient(LyricsSourceFormat.self, .sourceFormat),
            coverUrl: c.lenient(String.self, .coverUrl),
            musicLinks: c.lenient([String].self, .musicLinks))
    }
}
