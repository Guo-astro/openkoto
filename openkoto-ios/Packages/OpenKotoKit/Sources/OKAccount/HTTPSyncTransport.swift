import CryptoKit
import Foundation
import OKPersistence

/// `OpenKotoSyncTransport` 的生产实现：`/api/v1/sync/*`。
public struct HTTPSyncTransport: OpenKotoSyncTransport {
    public let api: CloudAPIClient

    public init(api: CloudAPIClient) {
        self.api = api
    }

    private func session() throws -> StoredSession {
        guard let session = api.currentSession else { throw CloudAPIError.notSignedIn }
        return session
    }

    public func accountID() async throws -> String { try session().user.id }

    public func deviceID() async throws -> String { try session().deviceId }

    /// `GET /api/v1/sync/pull`
    public func pull(cursor: String?, limit: Int) async throws -> SyncPullOutcome {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.insert(URLQueryItem(name: "cursor", value: cursor), at: 0) }
        do {
            let page = try await api.send(
                .init(path: "api/v1/sync/pull", query: query), as: SyncPullResponse.self)
            return .page(page)
        } catch CloudAPIError.cursorExpired {
            return .cursorExpired
        }
    }

    /// `POST /api/v1/sync/push`。整批 413 时对半拆开重发（协议 §5.5：拆小批次）。
    public func push(_ request: SyncPushRequest) async throws -> SyncPushResponse {
        do {
            return try await api.send(
                .init(method: "POST", path: "api/v1/sync/push",
                      body: try CloudAPIClient.jsonBody(request)),
                as: SyncPushResponse.self)
        } catch CloudAPIError.payloadTooLarge where request.ops.count > 1 {
            let middle = request.ops.count / 2
            let first = try await push(
                SyncPushRequest(deviceId: request.deviceId, ops: Array(request.ops[..<middle])))
            let second = try await push(
                SyncPushRequest(deviceId: request.deviceId, ops: Array(request.ops[middle...])))
            return SyncPushResponse(
                results: first.results + second.results, cursor: second.cursor ?? first.cursor)
        }
    }

    struct BlobTicketRequest: Encodable {
        let type: String
        let id: String
        let size: Int
        let sha256: String
    }

    struct BlobTicket: Decodable {
        let blobKey: String
        let uploadUrl: String
        let expiresAt: String?
    }

    /// `POST /api/v1/sync/blobs` 拿上传地址，再 `PUT` gzip 后的 payload。
    public func uploadBlob(type: String, id: String, payload: Data) async throws -> String {
        let compressed = try Gzip.compress(payload)
        let digest = SHA256.hash(data: compressed).map { String(format: "%02x", $0) }.joined()
        let ticket = try await api.send(
            .init(method: "POST", path: "api/v1/sync/blobs",
                  body: try CloudAPIClient.jsonBody(
                      BlobTicketRequest(type: type, id: id.lowercased(), size: compressed.count, sha256: digest))),
            as: BlobTicket.self)
        guard let url = URL(string: ticket.uploadUrl) else {
            throw CloudAPIError.decoding("invalid uploadUrl")
        }
        _ = try await api.send(
            .init(method: "PUT", path: "", body: compressed, contentType: "application/gzip",
                  absoluteURL: url))
        return ticket.blobKey
    }

    public func downloadBlob(_ url: String) async throws -> Data {
        guard let absolute = URL(string: url) else { throw CloudAPIError.decoding("invalid blobUrl") }
        let data = try await api.send(.init(path: "", absoluteURL: absolute))
        // 有的中间层会按 Content-Encoding 自动解压，拿到的已经是 JSON。
        if data.first == UInt8(ascii: "{") { return data }
        return try Gzip.decompress(data)
    }

    /// `GET /api/v1/sync/stats`
    public func stats() async throws -> SyncStats {
        try await api.send(.init(path: "api/v1/sync/stats"), as: SyncStats.self)
    }
}

/// `GET /api/v1/sync/stats` 的响应（协议 §5.3）。
public struct SyncStats: Codable, Sendable, Equatable {
    public struct Limits: Codable, Sendable, Equatable {
        public var vocabulary: Int?
        public var books: Int?
        public var bookFileBytes: Int?
        public var lyrics: Int?
        public var articles: Int?
    }

    public var counts: [String: Int]
    public var bytes: Int
    public var blobBytes: Int?
    public var plan: Plan
    public var limits: Limits?
}
