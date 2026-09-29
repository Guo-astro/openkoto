import Foundation

// OpenKoto 云同步协议 v1 的线上类型（`docs/specs/sync-protocol-spec.md` §2 / §5）。
//
// 放在 OKPersistence 而不是网络模块：`HTTPSyncEngine` 只依赖这里的类型与
// `OpenKotoSyncTransport` 协议，真正的 HTTP / 鉴权在 OKAccount 里实现。
// 这样引擎可以在单测里接一个纯内存的假服务端，也不会让持久层反向依赖 URLSession。

/// 任意 JSON 值。payload 对服务端是不透明的，但客户端要原样搬运（包括未知字段）。
public enum JSONValue: Codable, Sendable, Hashable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int64.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// 从一段 JSON 字节解析（payload 在本地一直是 `Data`）。
    public init(jsonData: Data) throws {
        self = try JSONDecoder().decode(JSONValue.self, from: jsonData)
    }

    /// 序列化成字节。`sortedKeys` 让同一个值永远得到同一串字节（哈希用）。
    public func jsonData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }
}

/// 服务端记录（pull 返回、conflict 的 `current`）。
public struct SyncRecordDTO: Codable, Sendable, Hashable {
    public var type: String
    public var id: String
    public var rev: Int64
    public var hlc: String
    public var deviceId: String?
    public var deleted: Bool
    public var payload: JSONValue?
    /// 超过 512 KB 的 payload 不内联，给一个短期有效的下载地址（gzip）。
    public var blobUrl: String?

    public init(
        type: String, id: String, rev: Int64, hlc: String, deviceId: String? = nil,
        deleted: Bool = false, payload: JSONValue? = nil, blobUrl: String? = nil
    ) {
        self.type = type
        self.id = id
        self.rev = rev
        self.hlc = hlc
        self.deviceId = deviceId
        self.deleted = deleted
        self.payload = payload
        self.blobUrl = blobUrl
    }
}

public struct SyncPullResponse: Codable, Sendable, Hashable {
    public var records: [SyncRecordDTO]
    public var cursor: String
    public var hasMore: Bool
    public var serverTime: String?

    public init(records: [SyncRecordDTO], cursor: String, hasMore: Bool, serverTime: String? = nil) {
        self.records = records
        self.cursor = cursor
        self.hasMore = hasMore
        self.serverTime = serverTime
    }
}

public struct SyncPushOp: Codable, Sendable, Hashable {
    public var opId: String
    public var type: String
    public var id: String
    public var baseRev: Int64
    public var hlc: String
    public var deleted: Bool
    public var payload: JSONValue?
    public var blobKey: String?

    public init(
        opId: String, type: String, id: String, baseRev: Int64, hlc: String,
        deleted: Bool, payload: JSONValue?, blobKey: String? = nil
    ) {
        self.opId = opId
        self.type = type
        self.id = id
        self.baseRev = baseRev
        self.hlc = hlc
        self.deleted = deleted
        self.payload = payload
        self.blobKey = blobKey
    }
}

public struct SyncPushRequest: Codable, Sendable, Hashable {
    public var deviceId: String
    public var ops: [SyncPushOp]

    public init(deviceId: String, ops: [SyncPushOp]) {
        self.deviceId = deviceId
        self.ops = ops
    }
}

public struct SyncPushResult: Codable, Sendable, Hashable {
    public enum Status: String, Codable, Sendable {
        case applied, conflict, rejected
    }

    public var opId: String
    public var status: Status
    public var rev: Int64?
    public var current: SyncRecordDTO?
    public var code: String?
    public var message: String?

    public init(
        opId: String, status: Status, rev: Int64? = nil, current: SyncRecordDTO? = nil,
        code: String? = nil, message: String? = nil
    ) {
        self.opId = opId
        self.status = status
        self.rev = rev
        self.current = current
        self.code = code
        self.message = message
    }
}

public struct SyncPushResponse: Codable, Sendable, Hashable {
    public var results: [SyncPushResult]
    public var cursor: String?

    public init(results: [SyncPushResult], cursor: String?) {
        self.results = results
        self.cursor = cursor
    }
}

/// 一次 pull 的结果。410 不是异常而是一种正常结局（要做全量重建）。
public enum SyncPullOutcome: Sendable {
    case page(SyncPullResponse)
    case cursorExpired
}

/// HTTP 同步的传输层。OKAccount 里的 `HTTPSyncTransport` 是生产实现。
public protocol OpenKotoSyncTransport: Sendable {
    /// 当前账号的 user id；游标与元数据按账号隔离，换账号时引擎据此整体作废。
    func accountID() async throws -> String
    /// 服务端分配给本设备的 id（HLC 的 nodeId 由它派生）。
    func deviceID() async throws -> String
    func pull(cursor: String?, limit: Int) async throws -> SyncPullOutcome
    func push(_ request: SyncPushRequest) async throws -> SyncPushResponse
    /// 上传超过内联上限的 payload（传输层负责 gzip），返回 `blobKey`。
    func uploadBlob(type: String, id: String, payload: Data) async throws -> String
    /// 下载 `blobUrl` 指向的 payload（传输层负责解压）。
    func downloadBlob(_ url: String) async throws -> Data
}

/// op 级错误码（协议 §5.5 末）。
public enum SyncOpErrorCode {
    public static let quotaExceeded = "QUOTA_EXCEEDED"
    public static let unknownType = "UNKNOWN_TYPE"
    public static let invalidPayload = "INVALID_PAYLOAD"
    public static let payloadTooLarge = "PAYLOAD_TOO_LARGE"
    public static let clockSkew = "CLOCK_SKEW"
    public static let immutable = "IMMUTABLE"
}
