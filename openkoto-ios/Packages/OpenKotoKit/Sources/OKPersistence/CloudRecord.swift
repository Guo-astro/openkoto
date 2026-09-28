import CloudKit
import CryptoKit
import Foundation
import OKModels

/// 参与 CloudKit 同步的记录种类。
///
/// `rawValue` 就是 CloudKit 的 record type，**改名等于换一张表**，
/// 老设备推上去的记录会变成孤儿。
public enum CloudRecordType: String, Sendable, CaseIterable {
    case vocabulary = "Vocabulary"
    case wordPack = "WordPack"
    case wordPackMembership = "WordPackMembership"
    case article = "Article"
    case segment = "Segment"
    case reviewEvent = "ReviewEvent"
    // 书籍与媒体：只同步**文本与元数据**，EPUB / 视频文件本身不上云。
    //
    // 归属关系（`bookChapter` / `mediaPart`）刻意做成**独立记录类型**而不是塞进
    // Article 的 payload：改 payload 结构的话，装着旧版的设备解不开会静默跳过
    // 所有文章。独立类型天生向前兼容 —— 旧版 `parse(recordName:)` 遇到未知类型
    // 返回 nil，直接忽略。
    case book = "Book"
    case bookChapter = "BookChapter"
    case bookMark = "BookMark"
    case media = "Media"
    case mediaPart = "MediaPart"
    /// 阅读进度（id = bookId，每本书一条）。**只走 OpenKoto 云**：
    /// CloudKit 那边刻意不同步阅读位置（见 `pendingCloudPayloads`），
    /// 这里多一个 case 只是让两套引擎共用同一份合并代码。
    case bookProgress = "BookProgress"
    /// 歌词元数据（id = articleId）。同样只走 OpenKoto 云。
    case lyricsMeta = "LyricsMeta"

    /// 合并顺序：被引用的先落地。
    ///
    /// CloudKit 一批记录回来时是**没有顺序保证**的，而它们之间有真外键：
    /// `favorite_vocabulary.source_article_id → article.id`、
    /// `segment.article_id → article.id`、`book_chapter` 两头（article + book）、
    /// `book_mark.book_id`、词包成员两头。被引用者排前面，绝大多数引用在同一批里
    /// 就能接上。跨批次到达的靠 `pending_cloud_payload` 停放重试（见 migration v10）。
    var mergeOrder: Int {
        switch self {
        // 与协议 §2.3 的 mergeOrder 同序。
        case .book: return 0
        case .media: return 1
        case .article: return 2
        case .lyricsMeta: return 3
        case .bookChapter: return 4
        case .mediaPart: return 5
        case .segment: return 6
        case .wordPack: return 7
        case .vocabulary: return 8
        case .wordPackMembership: return 9
        case .bookMark: return 10
        case .bookProgress: return 11
        case .reviewEvent: return 12
        }
    }
}

/// 领域模型 ↔ `CKRecord` 的编解码。
///
/// **整条记录按 JSON 存进一个字段，而不是逐字段映射。** 理由：
/// 逐字段映射意味着每个模型都要维护一份「属性名 → CKRecord key」的表，
/// 加一个字段忘了改就是静默丢数据；而我们从来不需要在云端按字段查询
/// （同步永远是整条读写）。JSON 一份，字段增减自动跟随 `Codable`。
///
/// 大记录（长章节正文）走 `CKAsset`：CKRecord 单条有 1MB 上限，
/// 一章 50 万字的小说正文能到 1.5MB，直接写字段会被服务端拒收。
public enum CloudRecord {
    /// 超过这个大小就改用 CKAsset。留足余量给其它字段与编码开销。
    static let inlinePayloadLimit = 700 * 1024

    static let payloadKey = "payload"
    static let payloadAssetKey = "payloadAsset"
    /// 冗余存一份，方便在 CloudKit Dashboard 里排查问题。
    static let updatedAtKey = "updatedAt"

    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    /// 解码端比编码端宽松：**接受带毫秒的 ISO 8601**。
    ///
    /// 我们自己编出来的永远不带毫秒（`.iso8601`），但 OpenKoto 云上的记录可能来自
    /// 网页 / 桌面（JS 的 `toISOString()` 必带毫秒）。严格的 `.iso8601` 解不开时
    /// 整条记录会被当成坏数据静默跳过 —— 那是最难排查的一类同步丢失。
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            if let date = parseISO8601(text) { return date }
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "invalid ISO 8601 date: \(text)")
        }
        return decoder
    }

    /// 带 / 不带毫秒两种都认。
    public static func parseISO8601(_ text: String) -> Date? {
        let plain = ISO8601DateFormatter()
        if let date = plain.date(from: text) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text)
    }

    /// 记录 ID：`类型_主键`。
    ///
    /// 带类型前缀是必需的 —— 文章与句子各有自己的 UUID 空间，不加前缀理论上可能撞。
    ///
    /// **分隔符必须是下划线。** 一开始用的是冒号，CloudKit 直接回
    /// `serverRejectedRequest`（error 15）——而且错误信息里完全看不出是记录名的问题。
    /// 词包成员的键本身还带一个分隔符，冒号方案会让记录名出现两个冒号。
    /// UUID 里不含下划线，所以 `split(maxSplits: 1)` 拆出来的类型与主键都不会歧义。
    public static func recordName(_ type: CloudRecordType, _ id: String) -> String {
        "\(type.rawValue)_\(id.lowercased())"
    }

    public static func parse(recordName: String) -> (type: CloudRecordType, id: String)? {
        let parts = recordName.split(separator: "_", maxSplits: 1)
        guard parts.count == 2, let type = CloudRecordType(rawValue: String(parts[0])) else {
            return nil
        }
        return (type, String(parts[1]))
    }

    /// 把 payload 写进记录，按大小自动选择内联还是 asset。
    ///
    /// - Parameter temporaryDirectory: asset 落盘的临时目录。CloudKit 要求
    ///   asset 是一个真实文件；上传完成后由系统清理。
    public static func write(
        payload: Data, into record: CKRecord, updatedAt: Date, temporaryDirectory: URL
    ) throws {
        record[updatedAtKey] = updatedAt as CKRecordValue
        if payload.count <= inlinePayloadLimit {
            record[payloadKey] = payload as CKRecordValue
            record[payloadAssetKey] = nil
        } else {
            let url = temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try payload.write(to: url, options: .atomic)
            record[payloadAssetKey] = CKAsset(fileURL: url)
            record[payloadKey] = nil
        }
    }

    // MARK: - 系统字段（change tag）

    /// 把记录的**系统字段**（recordID / recordType / change tag / 时间戳）序列化存起来。
    ///
    /// CloudKit 的保存是 compare-and-swap：请求里必须带上"我上次见到的 change tag"。
    /// 每次都现造一条空 `CKRecord` 等于说"这是新建的"，服务端一看已经有了，
    /// 就回 `serverRecordChanged` —— 于是**任何一条已在云上的记录都推不上去**。
    /// 用户看到的是 `partialFailure` + 一串 `serverRecordChanged`，
    /// 而错误信息里完全看不出缺的是 change tag。
    ///
    /// 只存系统字段、不存业务字段：payload 每次都从本地库现编，
    /// 避免同一份数据在两个地方各存一份、然后慢慢对不上。
    public static func encodeSystemFields(_ record: CKRecord) -> Data {
        let coder = NSKeyedArchiver(requiringSecureCoding: true)
        record.encodeSystemFields(with: coder)
        coder.finishEncoding()
        return coder.encodedData
    }

    /// 还原出一条只有系统字段的 `CKRecord`，业务字段留空等着现填。
    ///
    /// 解不开返回 nil（换过 CloudKit 版本、数据损坏）。调用方退回现造新记录：
    /// 那会走一次 `serverRecordChanged`，但下一轮就能靠服务端回传的记录自愈。
    public static func decodeSystemFields(_ data: Data) -> CKRecord? {
        guard let coder = try? NSKeyedUnarchiver(forReadingFrom: data) else { return nil }
        coder.requiresSecureCoding = true
        defer { coder.finishDecoding() }
        return CKRecord(coder: coder)
    }

    /// payload 的内容指纹，用来判断"这条跟云上那份一模一样，不用再推了"。
    public static func hash(_ payload: Data) -> String {
        SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
    }

    /// 从待推候选里滤掉内容与云端完全一致的，按 recordName 索引返回真正要推的。
    ///
    /// 两处回声都靠它掐掉：
    /// 1. 从云端拉回来的记录一落库，`updated_at` 就越过了水位线，下一轮扫描会原样推回去；
    /// 2. 水位线故意向前重叠 5 秒（见 `watermarkOverlap`），刚推成功的最后几条每轮都会重来。
    ///
    /// 有了 change tag 之后重推本身不会再报错，但它是纯粹的浪费 ——
    /// 而且每推一次就把 change tag 顶新一次，等于替其它设备制造冲突。
    public static func changedPayloads(
        _ payloads: [CloudPayload], knownHashes: [String: String]
    ) -> [String: CloudPayload] {
        var result: [String: CloudPayload] = [:]
        for payload in payloads {
            let name = recordName(payload.type, payload.id)
            if let known = knownHashes[name], known == hash(payload.data) { continue }
            result[name] = payload
        }
        return result
    }

    /// 读回 payload，内联与 asset 两种形态都认。
    public static func readPayload(from record: CKRecord) -> Data? {
        if let data = record[payloadKey] as? Data { return data }
        if let asset = record[payloadAssetKey] as? CKAsset,
            let url = asset.fileURL,
            let data = try? Data(contentsOf: url)
        {
            return data
        }
        return nil
    }
}
