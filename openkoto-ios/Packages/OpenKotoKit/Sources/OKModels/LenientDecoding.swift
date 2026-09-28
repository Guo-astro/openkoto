import Foundation

// 同步 payload 的宽松解码（同步协议 §2.2 / `packages/core/src/models.ts`）。
//
// 这些模型会从网页、桌面、CLI 同步过来：可选字段可能缺席或为 null，
// 日期可能带毫秒（由调用方的 dateDecodingStrategy 负责），网页导入的书没有
// `dirName` / `opfPath`。严格的合成解码遇到任何一处就整条失败，
// 而合并层把"解不开"当成坏数据**静默跳过** —— 那是最难发现的一类同步丢失。
//
// 规则：只有协议列出的必填字段（外加主键）是 `decode`，其余一律带默认值。
// 编码仍用合成实现（键名与 CodingKeys 一致），iOS 推出去的 payload 不变。

extension KeyedDecodingContainer {
    /// 缺席、null、类型不对都当作 nil。
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }
}

extension Article {
    enum CodingKeys: String, CodingKey {
        case id, title, content, sourceType, sourceURL, createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(UUID.self, forKey: .id),
            title: c.lenient(String.self, .title) ?? "",
            content: c.lenient(String.self, .content) ?? "",
            sourceType: c.lenient(SourceType.self, .sourceType),
            sourceURL: c.lenient(String.self, .sourceURL),
            createdAt: try c.decode(Date.self, forKey: .createdAt))
    }
}

extension ArticleSegment {
    enum CodingKeys: String, CodingKey {
        case id, articleId, order, text, readingText, translation, explanation
        case isNewParagraph, startTime, endTime, createdAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            id: try c.decode(UUID.self, forKey: .id),
            articleId: try c.decode(UUID.self, forKey: .articleId),
            order: try c.decode(Int.self, forKey: .order),
            text: try c.decode(String.self, forKey: .text),
            readingText: c.lenient(String.self, .readingText),
            translation: c.lenient(String.self, .translation),
            // 精讲结构对不上（别的客户端的新字段 / 旧格式）时只丢精讲，句子照收。
            explanation: c.lenient(SegmentExplanation.self, .explanation),
            isNewParagraph: c.lenient(Bool.self, .isNewParagraph) ?? false,
            startTime: c.lenient(Double.self, .startTime),
            endTime: c.lenient(Double.self, .endTime),
            createdAt: c.lenient(Date.self, .createdAt) ?? Date(timeIntervalSince1970: 0))
    }
}

extension WordPack {
    enum CodingKeys: String, CodingKey {
        case id, name, packDescription, coverURL, author, languageFrom, languageTo
        case tags, version, isSystem, createdAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let createdAt = try c.decode(Date.self, forKey: .createdAt)
        self.init(
            id: try c.decode(UUID.self, forKey: .id),
            name: try c.decode(String.self, forKey: .name),
            packDescription: c.lenient(String.self, .packDescription),
            coverURL: c.lenient(String.self, .coverURL),
            author: c.lenient(String.self, .author),
            languageFrom: c.lenient(String.self, .languageFrom),
            languageTo: c.lenient(String.self, .languageTo),
            tags: c.lenient([String].self, .tags) ?? [],
            version: c.lenient(String.self, .version),
            isSystem: c.lenient(Bool.self, .isSystem) ?? false,
            createdAt: createdAt,
            updatedAt: c.lenient(Date.self, .updatedAt) ?? createdAt)
    }
}

extension BookFormat {
    /// 不认识的格式按 TXT 处理：原生模式只需要章节正文，与原始格式无关。
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = BookFormat(rawValue: raw) ?? .txt
    }
}

extension BookRenderMode {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = BookRenderMode(rawValue: raw) ?? .native
    }
}

extension BookMark.Kind {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = BookMark.Kind(rawValue: raw) ?? .highlight
    }
}

extension Book {
    enum CodingKeys: String, CodingKey {
        case id, title, author, language, format, dirName, opfPath, coverHref
        case totalChars, defaultMode, originalOnly, createdAt
    }

    /// 网页导入的书没有 `dirName`（本机也没有原始文件）：用书 id 兜底。
    /// `BookStorage.directory(for:)` 本来就按 id 拼路径，`dirName` 不参与解析。
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(UUID.self, forKey: .id)
        self.init(
            id: id,
            title: try c.decode(String.self, forKey: .title),
            author: c.lenient(String.self, .author),
            language: c.lenient(String.self, .language),
            format: c.lenient(BookFormat.self, .format) ?? .txt,
            dirName: c.lenient(String.self, .dirName).flatMap { $0.isEmpty ? nil : $0 }
                ?? id.uuidString.lowercased(),
            opfPath: c.lenient(String.self, .opfPath),
            coverHref: c.lenient(String.self, .coverHref),
            totalChars: c.lenient(Int.self, .totalChars) ?? 0,
            defaultMode: c.lenient(BookRenderMode.self, .defaultMode) ?? .native,
            originalOnly: c.lenient(Bool.self, .originalOnly) ?? false,
            createdAt: try c.decode(Date.self, forKey: .createdAt))
    }
}

extension BookChapter {
    enum CodingKeys: String, CodingKey {
        case articleId, bookId, index, sourceHref, isSegmented, charCount
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            articleId: try c.decode(UUID.self, forKey: .articleId),
            bookId: try c.decode(UUID.self, forKey: .bookId),
            index: try c.decode(Int.self, forKey: .index),
            sourceHref: c.lenient(String.self, .sourceHref),
            // 网页可能已经切好句一并同步；没说就当没切，首开时 iOS 自己切。
            isSegmented: c.lenient(Bool.self, .isSegmented) ?? false,
            charCount: c.lenient(Int.self, .charCount) ?? 0)
    }
}

extension BookMark {
    enum CodingKeys: String, CodingKey {
        case id, bookId, chapterArticleId, chapterIndex, kind, segmentOrder, charStart, charEnd
        case locator, scrollFraction, selectedText, note, color, createdAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let createdAt = try c.decode(Date.self, forKey: .createdAt)
        self.init(
            id: try c.decode(UUID.self, forKey: .id),
            bookId: try c.decode(UUID.self, forKey: .bookId),
            chapterArticleId: c.lenient(UUID.self, .chapterArticleId),
            chapterIndex: c.lenient(Int.self, .chapterIndex) ?? 0,
            kind: c.lenient(Kind.self, .kind) ?? .highlight,
            segmentOrder: c.lenient(Int.self, .segmentOrder),
            charStart: c.lenient(Int.self, .charStart),
            charEnd: c.lenient(Int.self, .charEnd),
            locator: c.lenient(String.self, .locator),
            scrollFraction: c.lenient(Double.self, .scrollFraction),
            selectedText: c.lenient(String.self, .selectedText),
            note: c.lenient(String.self, .note),
            color: c.lenient(String.self, .color),
            createdAt: createdAt,
            updatedAt: c.lenient(Date.self, .updatedAt) ?? createdAt)
    }
}
