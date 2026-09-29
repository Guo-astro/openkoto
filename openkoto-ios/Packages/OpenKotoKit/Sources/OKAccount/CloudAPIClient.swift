import Foundation
import os

/// HTTP 层错误（`docs/specs/sync-protocol-spec.md` §5.5）。
public enum CloudAPIError: Error, Equatable, LocalizedError, Sendable {
    /// 本机没有登录会话。
    case notSignedIn
    /// 400 `BAD_REQUEST` 等：属于 bug，上报诊断。
    case badRequest(code: String, message: String)
    /// 401 且刷新令牌后仍失败 —— 要求重新登录。
    case unauthenticated(code: String, message: String)
    /// 403：缺 scope 或权益。
    case forbidden(code: String, message: String)
    case notFound(message: String)
    /// 410 `CURSOR_EXPIRED`：全量重建。
    case cursorExpired
    /// 413：请求体过大，拆小批次。
    case payloadTooLarge
    /// 426：提示升级 App。
    case clientTooOld
    /// 429：重试用尽后仍被限流。
    case rateLimited(retryAfter: TimeInterval?)
    /// 5xx：重试用尽。
    case server(status: Int, code: String, message: String)
    /// 其它 HTTP 状态。
    case http(status: Int, code: String, message: String)
    case network(String)
    case decoding(String)

    /// 这类错误只有重新登录能解决。
    public var requiresSignIn: Bool {
        switch self {
        case .notSignedIn, .unauthenticated: return true
        default: return false
        }
    }

    public var errorDescription: String? {
        switch self {
        case .notSignedIn: return "Not signed in"
        case .badRequest(let code, let message): return "\(code): \(message)"
        case .unauthenticated(let code, let message): return "\(code): \(message)"
        case .forbidden(let code, let message): return "\(code): \(message)"
        case .notFound(let message): return "NOT_FOUND: \(message)"
        case .cursorExpired: return "CURSOR_EXPIRED"
        case .payloadTooLarge: return "PAYLOAD_TOO_LARGE"
        case .clientTooOld: return "CLIENT_TOO_OLD"
        case .rateLimited: return "RATE_LIMITED"
        case .server(let status, let code, let message): return "HTTP \(status) \(code): \(message)"
        case .http(let status, let code, let message): return "HTTP \(status) \(code): \(message)"
        case .network(let message): return message
        case .decoding(let message): return "Invalid response: \(message)"
        }
    }

    /// 按状态码与响应体 `{ "error": { "code", "message" } }` 归类。
    static func from(status: Int, body: Data, retryAfter: TimeInterval?) -> CloudAPIError {
        struct Envelope: Decodable {
            struct Inner: Decodable {
                var code: String?
                var message: String?
            }
            var error: Inner?
        }
        let envelope = try? JSONDecoder().decode(Envelope.self, from: body)
        let code = envelope?.error?.code ?? "HTTP_\(status)"
        let message = envelope?.error?.message ?? HTTPURLResponse.localizedString(forStatusCode: status)
        switch status {
        case 400: return .badRequest(code: code, message: message)
        case 401: return .unauthenticated(code: code, message: message)
        case 403: return .forbidden(code: code, message: message)
        case 404: return .notFound(message: message)
        case 410: return .cursorExpired
        case 413: return .payloadTooLarge
        case 426: return .clientTooOld
        case 429: return .rateLimited(retryAfter: retryAfter)
        case 500...599: return .server(status: status, code: code, message: message)
        default: return .http(status: status, code: code, message: message)
        }
    }
}

/// OpenKoto 云 API 客户端：协议头、令牌自动刷新（single-flight）、429 / 5xx 退避。
///
/// 所有端点共用这一个入口，**鉴权与重试只有一份实现**。
public actor CloudAPIClient {
    public struct Request: Sendable {
        public var method: String
        public var path: String
        public var query: [URLQueryItem]
        public var body: Data?
        public var contentType: String?
        public var authenticated: Bool
        /// 绝对地址（blob 的上传 / 下载地址由服务端给出）。设置后忽略 `path`。
        public var absoluteURL: URL?

        public init(
            method: String = "GET", path: String, query: [URLQueryItem] = [], body: Data? = nil,
            contentType: String? = "application/json", authenticated: Bool = true,
            absoluteURL: URL? = nil
        ) {
            self.method = method
            self.path = path
            self.query = query
            self.body = body
            self.contentType = contentType
            self.authenticated = authenticated
            self.absoluteURL = absoluteURL
        }
    }

    public nonisolated let configuration: AccountConfiguration
    public nonisolated let tokenStore: any TokenStore
    private let session: URLSession
    private let maxRetries: Int
    private let sleep: @Sendable (TimeInterval) async throws -> Void
    private let now: @Sendable () -> Date
    private var refreshTask: Task<StoredSession, Error>?
    private var invalidationHandler: (@Sendable () async -> Void)?
    private let logger = Logger(subsystem: "app.openkoto", category: "CloudAPI")

    /// 最长退避（协议 §5.5：指数退避最长 5 分钟）。
    static let maxBackoff: TimeInterval = 300

    public init(
        configuration: AccountConfiguration,
        tokenStore: any TokenStore = KeychainTokenStore(),
        session: URLSession = .shared,
        maxRetries: Int = 3,
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.configuration = configuration
        self.tokenStore = tokenStore
        self.session = session
        self.maxRetries = maxRetries
        self.sleep = sleep
        self.now = now
    }

    /// 刷新令牌被服务端判死（吊销 / 复用检测 / 过期）时回调，UI 据此回到未登录态。
    public func setInvalidationHandler(_ handler: (@Sendable () async -> Void)?) {
        invalidationHandler = handler
    }

    // MARK: - 发送

    /// 指数退避：1s、2s、4s……封顶 5 分钟。
    static func backoff(attempt: Int) -> TimeInterval {
        min(maxBackoff, pow(2, Double(attempt)))
    }

    static func retryAfter(_ response: HTTPURLResponse) -> TimeInterval? {
        guard let raw = response.value(forHTTPHeaderField: "Retry-After") else { return nil }
        if let seconds = TimeInterval(raw.trimmingCharacters(in: .whitespaces)) {
            return max(0, seconds)
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter.date(from: raw).map { max(0, $0.timeIntervalSinceNow) }
    }

    func urlRequest(for request: Request, accessToken: String?) throws -> URLRequest {
        let url: URL
        if let absolute = request.absoluteURL {
            url = absolute
        } else {
            guard
                var components = URLComponents(
                    url: configuration.baseURL.appendingPathComponent(request.path),
                    resolvingAgainstBaseURL: false)
            else { throw CloudAPIError.badRequest(code: "BAD_URL", message: request.path) }
            if !request.query.isEmpty { components.queryItems = request.query }
            guard let built = components.url else {
                throw CloudAPIError.badRequest(code: "BAD_URL", message: request.path)
            }
            url = built
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if request.body != nil, let contentType = request.contentType {
            urlRequest.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        urlRequest.setValue(
            String(AccountConfiguration.protocolVersion), forHTTPHeaderField: "X-OpenKoto-Protocol")
        urlRequest.setValue(configuration.clientHeader, forHTTPHeaderField: "X-OpenKoto-Client")
        if let accessToken {
            urlRequest.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }
        return urlRequest
    }

    /// 发一个请求，返回 2xx 的响应体。
    ///
    /// - 401：刷新令牌后重试**一次**；仍然 401 → `.unauthenticated`。
    /// - 429：按 `Retry-After` 等待后重试；5xx / 网络错误：指数退避重试。
    public func send(_ request: Request) async throws -> Data {
        var refreshed = false
        var attempt = 0
        while true {
            var token: String?
            if request.authenticated {
                token = try await validAccessToken().accessToken
            }
            let urlRequest = try urlRequest(for: request, accessToken: token)

            let data: Data
            let http: HTTPURLResponse
            do {
                let (body, response) = try await session.data(for: urlRequest)
                guard let response = response as? HTTPURLResponse else {
                    throw CloudAPIError.network("non-HTTP response")
                }
                data = body
                http = response
            } catch let error as CloudAPIError {
                throw error
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                if (error as? URLError)?.code == .cancelled { throw CancellationError() }
                if attempt < maxRetries {
                    try await sleep(Self.backoff(attempt: attempt))
                    attempt += 1
                    continue
                }
                throw CloudAPIError.network(error.localizedDescription)
            }

            if (200..<300).contains(http.statusCode) { return data }

            let retryAfter = Self.retryAfter(http)
            let error = CloudAPIError.from(status: http.statusCode, body: data, retryAfter: retryAfter)
            switch http.statusCode {
            case 401 where request.authenticated && !refreshed:
                refreshed = true
                _ = try await refresh()
                continue
            case 401 where request.authenticated:
                // 刚换的令牌仍被拒：会话在服务端已经失效（设备被吊销等）。
                await invalidate()
                throw error
            case 429 where attempt < maxRetries:
                try await sleep(min(Self.maxBackoff, retryAfter ?? Self.backoff(attempt: attempt)))
                attempt += 1
                continue
            case 500...599 where attempt < maxRetries:
                try await sleep(Self.backoff(attempt: attempt))
                attempt += 1
                continue
            default:
                throw error
            }
        }
    }

    public func send<Response: Decodable>(_ request: Request, as type: Response.Type) async throws
        -> Response
    {
        let data = try await send(request)
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw CloudAPIError.decoding(String(describing: error))
        }
    }

    static func jsonBody<Body: Encodable>(_ body: Body) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return try encoder.encode(body)
    }

    // MARK: - 令牌

    /// 当前可用的 access token；快过期了就先刷新。
    func validAccessToken() async throws -> StoredSession {
        guard let stored = tokenStore.load() else { throw CloudAPIError.notSignedIn }
        if stored.accessTokenIsFresh(now: now()) { return stored }
        return try await refresh()
    }

    /// 刷新令牌。**single-flight**：并发调用共享同一次网络请求 ——
    /// refresh token 每用一次就轮换，两个请求各刷一次的话，第二个会被服务端当成
    /// "旧 token 复用"，整个设备被吊销。
    @discardableResult
    public func refresh() async throws -> StoredSession {
        if let refreshTask { return try await refreshTask.value }
        let task = Task { try await self.performRefresh() }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }

    private func performRefresh() async throws -> StoredSession {
        guard let stored = tokenStore.load() else { throw CloudAPIError.notSignedIn }
        struct Body: Encodable {
            let grant_type = "refresh_token"
            let refreshToken: String
        }
        let request = Request(
            method: "POST", path: "api/v1/auth/token",
            body: try Self.jsonBody(Body(refreshToken: stored.refreshToken)),
            authenticated: false)
        do {
            let response = try await send(request, as: TokenResponse.self)
            let session = StoredSession(response, now: now())
            tokenStore.save(session)
            return session
        } catch let error as CloudAPIError {
            switch error {
            case .badRequest, .unauthenticated, .forbidden:
                // invalid_grant：吊销、过期或复用检测。只能重新登录。
                logger.notice("refresh rejected: \(error.localizedDescription, privacy: .public)")
                await invalidate()
                throw CloudAPIError.unauthenticated(code: "invalid_grant", message: error.localizedDescription)
            default:
                throw error
            }
        }
    }

    private func invalidate() async {
        tokenStore.clear()
        await invalidationHandler?()
    }

    /// 登录成功后存下会话。
    @discardableResult
    public func store(_ response: TokenResponse) -> StoredSession {
        let session = StoredSession(response, now: now())
        tokenStore.save(session)
        return session
    }

    public nonisolated var currentSession: StoredSession? { tokenStore.load() }
}
