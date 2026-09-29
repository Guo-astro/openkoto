import Foundation
import OKPersistence

@testable import OKAccount

/// URLProtocol 桩：按 host 路由到各测试自己的假服务端（swift-testing 默认并行跑，
/// 用 host 隔离而不是全局单例）。
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest, Data?) -> (status: Int, headers: [String: String], body: Data)

    private static let lock = NSLock()
    nonisolated(unsafe) private static var handlers: [String: Handler] = [:]

    static func register(host: String, handler: @escaping Handler) {
        lock.withLock { handlers[host] = handler }
    }

    static func unregister(host: String) {
        lock.withLock { _ = handlers.removeValue(forKey: host) }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let host = request.url?.host ?? ""
        guard let handler = Self.lock.withLock({ Self.handlers[host] }) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let body = request.httpBody ?? Self.readStream(request.httpBodyStream)
        let (status, headers, data) = handler(request, body)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readStream(_ stream: InputStream?) -> Data? {
        guard let stream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

/// 最小可用的 OpenKoto 云假服务端：令牌、`/me`、设备、`/sync/*`（规则照抄
/// `server/worker/src/sync/vault.ts`：rev 自增、baseRev/HLC 冲突、ReviewEvent 只追加、
/// 配额、墓碑地板 → 410）。
final class FakeCloud: @unchecked Sendable {
    struct Record {
        var type: String
        var id: String
        var rev: Int64
        var hlc: String
        var deviceId: String
        var deleted: Bool
        var payload: JSONValue?
        var blobKey: String?
    }

    struct Logged {
        var method: String
        var path: String
        var query: [String: String]
        var headers: [String: String]
        var body: Data?
    }

    let host = "cloud-\(UUID().uuidString.lowercased()).test"
    var baseURL: URL { URL(string: "https://\(host)")! }

    private let lock = NSLock()
    private var _records: [String: Record] = [:]
    private var seq: Int64 = 0
    private var _log: [Logged] = []
    private var blobs: [String: Data] = [:]

    // 令牌
    var validAccessTokens: Set<String> = ["access-1"]
    var refreshCount = 0
    var nextTokenIndex = 2
    var currentRefreshToken = "okr_refresh-1"

    // 故障注入
    var tombstoneFloor: Int64 = 0
    var vocabularyLimit: Int?
    /// 前 N 个 `/sync/*` 请求直接回这个状态码。
    var failures: [(status: Int, headers: [String: String])] = []

    let userID = "user-1"
    let deviceID = "D7F1A2B3-0000-4000-8000-000000000000"

    init() {
        StubURLProtocol.register(host: host) { [unowned self] request, body in
            self.handle(request, body: body)
        }
    }

    deinit { StubURLProtocol.unregister(host: host) }

    var records: [String: Record] { lock.withLock { _records } }
    var log: [Logged] { lock.withLock { _log } }

    func record(_ type: String, _ id: String) -> Record? {
        lock.withLock { _records["\(type)|\(id.lowercased())"] }
    }

    var pushRequests: [SyncPushRequest] {
        log.filter { $0.path == "/api/v1/sync/push" }.compactMap {
            $0.body.flatMap { try? JSONDecoder().decode(SyncPushRequest.self, from: $0) }
        }
    }

    /// 模拟"另一台设备"写入。
    @discardableResult
    func write(type: String, id: String, hlc: String, payload: JSONValue?, deleted: Bool = false) -> Int64 {
        lock.withLock {
            seq += 1
            _records["\(type)|\(id.lowercased())"] = Record(
                type: type, id: id.lowercased(), rev: seq, hlc: hlc, deviceId: "other",
                deleted: deleted, payload: deleted ? nil : payload)
            return seq
        }
    }

    var currentSeq: Int64 { lock.withLock { seq } }

    func session(now: Date = .now) -> StoredSession {
        StoredSession(
            accessToken: "access-1", refreshToken: currentRefreshToken,
            accessTokenExpiresAt: now.addingTimeInterval(900), deviceId: deviceID,
            user: AccountUser(id: userID, email: "you@example.com", name: "You", plan: .free))
    }

    // MARK: - 路由

    private func json<T: Encodable>(_ value: T, status: Int = 200, headers: [String: String] = [:])
        -> (Int, [String: String], Data)
    {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return (status, headers.merging(["Content-Type": "application/json"]) { a, _ in a },
                (try? encoder.encode(value)) ?? Data())
    }

    private func error(_ status: Int, _ code: String, _ message: String = "", headers: [String: String] = [:])
        -> (Int, [String: String], Data)
    {
        json(["error": ["code": code, "message": message]], status: status, headers: headers)
    }

    private func handle(_ request: URLRequest, body: Data?) -> (Int, [String: String], Data) {
        let url = request.url!
        let path = url.path
        let query = Dictionary(
            (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map {
                ($0.name, $0.value ?? "")
            }, uniquingKeysWith: { a, _ in a })
        lock.withLock {
            _log.append(
                Logged(
                    method: request.httpMethod ?? "GET", path: path, query: query,
                    headers: request.allHTTPHeaderFields ?? [:], body: body))
        }

        if path == "/api/v1/auth/token" { return token(body) }
        if path == "/api/v1/auth/logout" { return json(["ok": true]) }

        // 其余都要鉴权
        let auth = request.value(forHTTPHeaderField: "Authorization") ?? ""
        let token = auth.hasPrefix("Bearer ") ? String(auth.dropFirst(7)) : ""
        guard lock.withLock({ validAccessTokens.contains(token) }) else {
            return error(401, "TOKEN_EXPIRED", "access token expired")
        }
        if path.hasPrefix("/api/v1/sync/"),
            let failure = lock.withLock({ failures.isEmpty ? nil : failures.removeFirst() })
        {
            return error(failure.status, failure.status == 429 ? "RATE_LIMITED" : "INTERNAL", headers: failure.headers)
        }

        switch (request.httpMethod ?? "GET", path) {
        case ("GET", "/api/v1/me"):
            return json(
                AccountSummaryDTO(
                    user: .init(id: userID, email: "you@example.com", name: "You", image: nil, createdAt: "2026-09-01T00:00:00.000Z"),
                    plan: "plus", credits: 0, pendingDeletion: nil))
        case ("GET", "/api/v1/devices"):
            return json([
                "devices": [
                    DeviceSummary(id: deviceID, platform: "ios", name: "iPhone", appVersion: "1.2.3", createdAt: "2026-09-01T00:00:00.000Z", lastSeenAt: "2026-09-28T00:00:00.000Z", current: true),
                    DeviceSummary(id: "dev-2", platform: "web", name: "Chrome", current: false),
                ]
            ])
        case ("GET", "/api/v1/sync/pull"): return pull(query)
        case ("POST", "/api/v1/sync/push"): return push(body)
        case ("POST", "/api/v1/sync/blobs"):
            let ticket = (try? JSONDecoder().decode([String: JSONValue].self, from: body ?? Data())) ?? [:]
            let key = "\(ticket["type"]?.stringValue ?? "")/\(ticket["id"]?.stringValue ?? "")/\(ticket["sha256"]?.stringValue ?? "")"
            return json([
                "blobKey": key,
                "uploadUrl": "https://\(host)/api/v1/sync/blob/\(key.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)",
                "expiresAt": "2026-09-28T11:00:00.000Z",
            ])
        default:
            if path.hasPrefix("/api/v1/sync/blob/") {
                let key = String(path.dropFirst("/api/v1/sync/blob/".count))
                if request.httpMethod == "PUT" {
                    lock.withLock { blobs[key] = body ?? Data() }
                    return json(["ok": true])
                }
                guard let data = lock.withLock({ blobs[key] }) else { return error(404, "NOT_FOUND") }
                return (200, ["Content-Type": "application/gzip"], data)
            }
            return error(404, "NOT_FOUND")
        }
    }

    struct AccountSummaryDTO: Encodable {
        struct User: Encodable {
            var id, email, name: String
            var image: String?
            var createdAt: String
        }
        var user: User
        var plan: String
        var credits: Double
        var pendingDeletion: String?
    }

    private func token(_ body: Data?) -> (Int, [String: String], Data) {
        let fields = (try? JSONDecoder().decode([String: JSONValue].self, from: body ?? Data())) ?? [:]
        let grant = fields["grant_type"]?.stringValue ?? ""
        switch grant {
        case "refresh_token":
            let presented = fields["refreshToken"]?.stringValue ?? ""
            return lock.withLock {
                guard presented == currentRefreshToken else {
                    return error(401, "invalid_grant", "refresh token revoked")
                }
                refreshCount += 1
                let access = "access-\(nextTokenIndex)"
                currentRefreshToken = "okr_refresh-\(nextTokenIndex)"
                nextTokenIndex += 1
                validAccessTokens = [access]
                return json(tokenResponse(access: access, refresh: currentRefreshToken))
            }
        case "authorization_code":
            guard fields["code"]?.stringValue == "the-code",
                fields["redirect_uri"]?.stringValue == "openkoto://auth/callback",
                let verifier = fields["code_verifier"]?.stringValue, !verifier.isEmpty,
                fields["device"]?["platform"]?.stringValue == "ios"
            else { return error(400, "invalid_grant", "bad code") }
            return json(tokenResponse(access: "access-1", refresh: currentRefreshToken))
        default:
            return error(400, "unsupported_grant_type")
        }
    }

    private func tokenResponse(access: String, refresh: String) -> TokenResponse {
        TokenResponse(
            accessToken: access, refreshToken: refresh, expiresIn: 900, deviceId: deviceID,
            user: AccountUser(id: userID, email: "you@example.com", name: "You", plan: .free))
    }

    private func pull(_ query: [String: String]) -> (Int, [String: String], Data) {
        let after = Int64(query["cursor"].map { $0.replacingOccurrences(of: "c_", with: "") } ?? "0") ?? 0
        let limit = Int(query["limit"] ?? "500") ?? 500
        return lock.withLock {
            if after > 0 && after < tombstoneFloor { return error(410, "CURSOR_EXPIRED") }
            let rows = _records.values.filter { $0.rev > after }.sorted { $0.rev < $1.rev }
            let page = Array(rows.prefix(limit))
            let hasMore = rows.count > page.count
            let cursor = hasMore ? page.last!.rev : max(after, seq)
            let records = page.map { row in
                SyncRecordDTO(
                    type: row.type, id: row.id, rev: row.rev, hlc: row.hlc, deviceId: row.deviceId,
                    deleted: row.deleted, payload: row.payload,
                    blobUrl: row.blobKey.map {
                        "https://\(host)/api/v1/sync/blob/\($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)"
                    })
            }
            return json(SyncPullResponse(records: records, cursor: "c_\(cursor)", hasMore: hasMore, serverTime: "2026-09-28T10:00:00.000Z"))
        }
    }

    private func push(_ body: Data?) -> (Int, [String: String], Data) {
        guard let request = try? JSONDecoder().decode(SyncPushRequest.self, from: body ?? Data()) else {
            return error(400, "BAD_REQUEST")
        }
        return lock.withLock {
            var results: [SyncPushResult] = []
            for op in request.ops {
                let key = "\(op.type)|\(op.id.lowercased())"
                let existing = _records[key]
                if op.type == "ReviewEvent" {
                    if op.deleted { results.append(.init(opId: op.opId, status: .rejected, code: "IMMUTABLE")); continue }
                    if let existing { results.append(.init(opId: op.opId, status: .applied, rev: existing.rev)); continue }
                }
                let wins = existing == nil || existing!.rev == op.baseRev || op.hlc > existing!.hlc
                if !wins, let existing {
                    results.append(
                        .init(
                            opId: op.opId, status: .conflict, rev: existing.rev,
                            current: SyncRecordDTO(
                                type: existing.type, id: existing.id, rev: existing.rev, hlc: existing.hlc,
                                deviceId: existing.deviceId, deleted: existing.deleted, payload: existing.payload)))
                    continue
                }
                let creating = !op.deleted && (existing == nil || existing!.deleted)
                if creating, op.type == "Vocabulary", let limit = vocabularyLimit,
                    _records.values.filter({ $0.type == "Vocabulary" && !$0.deleted }).count >= limit
                {
                    results.append(.init(opId: op.opId, status: .rejected, code: "QUOTA_EXCEEDED", message: "vocabulary limit reached"))
                    continue
                }
                seq += 1
                _records[key] = Record(
                    type: op.type, id: op.id.lowercased(), rev: seq, hlc: op.hlc, deviceId: request.deviceId,
                    deleted: op.deleted, payload: op.deleted ? nil : op.payload,
                    blobKey: op.deleted ? nil : op.blobKey)
                results.append(.init(opId: op.opId, status: .applied, rev: seq))
            }
            return json(SyncPushResponse(results: results, cursor: "c_\(seq)"))
        }
    }

    // MARK: - 客户端工厂

    func urlSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    func client(
        store: (any TokenStore)? = nil, maxRetries: Int = 3,
        sleeps: SleepRecorder = SleepRecorder()
    ) -> CloudAPIClient {
        CloudAPIClient(
            configuration: AccountConfiguration(
                baseURL: baseURL, platform: "ios", appVersion: "1.2.3", deviceName: "Test iPhone"),
            tokenStore: store ?? InMemoryTokenStore(session()),
            session: urlSession(),
            maxRetries: maxRetries,
            sleep: { seconds in sleeps.record(seconds) })
    }
}

final class SleepRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _durations: [TimeInterval] = []
    var durations: [TimeInterval] { lock.withLock { _durations } }
    func record(_ seconds: TimeInterval) { lock.withLock { _durations.append(seconds) } }
}
