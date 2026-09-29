import CryptoKit
import Foundation
import Security

/// PKCE（RFC 7636，S256）。
public struct PKCE: Sendable, Equatable {
    public let verifier: String
    public let challenge: String

    public init(verifier: String) {
        self.verifier = verifier
        self.challenge = Self.challenge(for: verifier)
    }

    /// 32 字节随机数 → 43 位 base64url（服务端要求 challenge ≥ 43 位）。
    public static func generate() -> PKCE {
        PKCE(verifier: randomURLSafeString(byteCount: 32))
    }

    public static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func randomURLSafeString(byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        if SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes) != errSecSuccess {
            for index in bytes.indices { bytes[index] = UInt8.random(in: 0...255) }
        }
        return base64URL(Data(bytes))
    }
}

/// 一次网页授权的临时状态（PKCE + state）。
public struct AuthorizationRequest: Sendable, Equatable {
    public let pkce: PKCE
    public let state: String
    public let url: URL
}

/// 认证相关端点（`docs/specs/auth-spec.md` §3）。
///
/// 只管 HTTP；弹浏览器 / Apple 登录面板的部分在 `SignInProviders.swift`（需要 UI 框架）。
public struct AuthClient: Sendable {
    public let api: CloudAPIClient

    public init(api: CloudAPIClient) {
        self.api = api
    }

    public var configuration: AccountConfiguration { api.configuration }

    // MARK: - 授权码 + PKCE（邮箱 / Google 等网页登录）

    /// `GET {base}/auth/native/authorize?...`
    public func makeAuthorizationRequest(
        pkce: PKCE = .generate(), state: String = PKCE.randomURLSafeString(byteCount: 16)
    ) -> AuthorizationRequest {
        var components = URLComponents(
            url: configuration.baseURL.appendingPathComponent("auth/native/authorize"),
            resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: configuration.clientID),
            URLQueryItem(name: "redirect_uri", value: AccountConfiguration.redirectURI),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
        ]
        return AuthorizationRequest(pkce: pkce, state: state, url: components.url!)
    }

    /// 解析回调 `openkoto://auth/callback?code=…&state=…`，校验 state。
    public static func authorizationCode(from callback: URL, expectedState: String) throws -> String {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        if let error = value("error") {
            throw AuthError.authorizationFailed(value("error_description") ?? error)
        }
        guard value("state") == expectedState else { throw AuthError.stateMismatch }
        guard let code = value("code"), !code.isEmpty else { throw AuthError.missingCode }
        return code
    }

    struct CodeExchangeBody: Encodable {
        let grant_type = "authorization_code"
        let code: String
        let code_verifier: String
        let redirect_uri: String
        let device: DeviceDescriptor
    }

    /// `POST /api/v1/auth/token`（grant_type=authorization_code）。成功后存入 Keychain。
    @discardableResult
    public func exchange(code: String, verifier: String) async throws -> StoredSession {
        let body = CodeExchangeBody(
            code: code, code_verifier: verifier, redirect_uri: AccountConfiguration.redirectURI,
            device: configuration.device)
        let response = try await api.send(
            .init(method: "POST", path: "api/v1/auth/token", body: try CloudAPIClient.jsonBody(body),
                  authenticated: false),
            as: TokenResponse.self)
        return await api.store(response)
    }

    // MARK: - Sign in with Apple（原生）

    public struct AppleFullName: Codable, Sendable, Equatable {
        public var givenName: String?
        public var familyName: String?

        public init(givenName: String?, familyName: String?) {
            self.givenName = givenName
            self.familyName = familyName
        }
    }

    struct AppleBody: Encodable {
        let identityToken: String
        let nonce: String
        let fullName: AppleFullName?
        let device: DeviceDescriptor
    }

    /// `POST /api/v1/auth/apple`。`nonce` 传**原始值**：请求 Apple 时填的是它的 SHA-256，
    /// 服务端（Better Auth，`nonceComparison: exact-or-sha256`）会自己哈希后比对。
    @discardableResult
    public func signInWithApple(identityToken: String, rawNonce: String, fullName: AppleFullName?)
        async throws -> StoredSession
    {
        let body = AppleBody(
            identityToken: identityToken, nonce: rawNonce, fullName: fullName,
            device: configuration.device)
        let response = try await api.send(
            .init(method: "POST", path: "api/v1/auth/apple", body: try CloudAPIClient.jsonBody(body),
                  authenticated: false),
            as: TokenResponse.self)
        return await api.store(response)
    }

    /// 32 字节随机原始 nonce。
    public static func makeNonce() -> String { PKCE.randomURLSafeString(byteCount: 32) }

    /// 填给 `ASAuthorizationAppleIDRequest.nonce` 的值：原始 nonce 的 SHA-256（十六进制）。
    public static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - 会话管理

    /// `POST /api/v1/auth/logout`：吊销本设备。无论服务端成败，本地都清掉。
    public func logout() async {
        if let session = api.currentSession {
            struct Body: Encodable { let refreshToken: String }
            _ = try? await api.send(
                .init(method: "POST", path: "api/v1/auth/logout",
                      body: try? CloudAPIClient.jsonBody(Body(refreshToken: session.refreshToken)),
                      authenticated: false))
        }
        api.tokenStore.clear()
    }

    /// `GET /api/v1/me`
    public func me() async throws -> AccountSummary {
        try await api.send(.init(path: "api/v1/me"), as: AccountSummary.self)
    }

    /// `GET /api/v1/devices`
    public func devices() async throws -> [DeviceSummary] {
        try await api.send(.init(path: "api/v1/devices"), as: DevicesResponse.self).devices
    }

    /// `DELETE /api/v1/devices/:id`
    public func revokeDevice(id: String) async throws {
        let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try await api.send(.init(method: "DELETE", path: "api/v1/devices/\(encoded)"))
    }
}

public enum AuthError: Error, Equatable, LocalizedError {
    case stateMismatch
    case missingCode
    case authorizationFailed(String)
    case cancelled
    case missingIdentityToken

    public var errorDescription: String? {
        switch self {
        case .stateMismatch: return "Sign-in state mismatch"
        case .missingCode: return "Sign-in returned no authorization code"
        case .authorizationFailed(let message): return message
        case .cancelled: return "Sign-in cancelled"
        case .missingIdentityToken: return "Apple returned no identity token"
        }
    }
}
