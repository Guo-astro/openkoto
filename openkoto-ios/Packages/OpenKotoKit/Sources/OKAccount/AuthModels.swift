import Foundation

// 与 `server/worker/src/auth/tokens.ts`、`auth/routes.ts`、`account/routes.ts`
// 的 JSON 逐字段对应。服务端新增可选字段不影响解码（Codable 忽略未知键）。

public enum Plan: String, Codable, Sendable, CaseIterable {
    case free, plus, pro

    /// 未知套餐名（服务端将来新增）按 free 处理，而不是整个响应解不开。
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Plan(rawValue: raw) ?? .free
    }
}

/// `device` 字段：`{ platform, name, appVersion }`。
public struct DeviceDescriptor: Codable, Sendable, Equatable {
    public var platform: String
    public var name: String
    public var appVersion: String?

    public init(platform: String, name: String, appVersion: String?) {
        self.platform = platform
        self.name = name
        self.appVersion = appVersion
    }
}

/// 令牌响应里的用户快照。
public struct AccountUser: Codable, Sendable, Equatable {
    public var id: String
    public var email: String
    public var name: String?
    public var plan: Plan?

    public init(id: String, email: String, name: String? = nil, plan: Plan? = nil) {
        self.id = id
        self.email = email
        self.name = name
        self.plan = plan
    }
}

/// `POST /api/v1/auth/token` / `POST /api/v1/auth/apple` 的响应。
public struct TokenResponse: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String
    public var tokenType: String?
    public var expiresIn: Int
    public var deviceId: String
    public var user: AccountUser

    public init(
        accessToken: String, refreshToken: String, tokenType: String? = "Bearer",
        expiresIn: Int, deviceId: String, user: AccountUser
    ) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.tokenType = tokenType
        self.expiresIn = expiresIn
        self.deviceId = deviceId
        self.user = user
    }
}

/// 存进 Keychain 的会话。
public struct StoredSession: Codable, Sendable, Equatable {
    public var accessToken: String
    public var refreshToken: String
    public var accessTokenExpiresAt: Date
    public var deviceId: String
    public var user: AccountUser

    public init(
        accessToken: String, refreshToken: String, accessTokenExpiresAt: Date, deviceId: String,
        user: AccountUser
    ) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.accessTokenExpiresAt = accessTokenExpiresAt
        self.deviceId = deviceId
        self.user = user
    }

    public init(_ response: TokenResponse, now: Date = .now) {
        self.init(
            accessToken: response.accessToken, refreshToken: response.refreshToken,
            accessTokenExpiresAt: now.addingTimeInterval(TimeInterval(response.expiresIn)),
            deviceId: response.deviceId, user: response.user)
    }

    /// 提前一分钟当作过期，避免请求在路上过期。
    public func accessTokenIsFresh(now: Date = .now) -> Bool {
        accessTokenExpiresAt.timeIntervalSince(now) > 60
    }
}

/// `GET /api/v1/me`。
public struct AccountSummary: Codable, Sendable, Equatable {
    public struct User: Codable, Sendable, Equatable {
        public var id: String
        public var email: String
        public var name: String?
        public var image: String?
        public var createdAt: String?
    }

    public struct Entitlements: Codable, Sendable, Equatable {
        public var sync: Bool?
        public var cli: Bool?
        public var apiKeys: Bool?
        public var hostedAi: Bool?
    }

    public var user: User
    public var plan: Plan
    public var entitlements: Entitlements?
    public var credits: Double?
    /// 已申请删除时为执行时间（ISO 8601），否则 nil。
    public var pendingDeletion: String?
}

/// `GET /api/v1/devices` 的一项。
public struct DeviceSummary: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var platform: String
    public var name: String
    public var appVersion: String?
    public var createdAt: String?
    public var lastSeenAt: String?
    public var current: Bool

    public init(
        id: String, platform: String, name: String, appVersion: String? = nil,
        createdAt: String? = nil, lastSeenAt: String? = nil, current: Bool = false
    ) {
        self.id = id
        self.platform = platform
        self.name = name
        self.appVersion = appVersion
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.current = current
    }

    public var lastSeenDate: Date? {
        lastSeenAt.flatMap(ISO8601.parse)
    }
}

struct DevicesResponse: Codable {
    var devices: [DeviceSummary]
}

struct OKResponse: Codable {
    var ok: Bool?
}

enum ISO8601 {
    static func parse(_ text: String) -> Date? {
        let plain = ISO8601DateFormatter()
        if let date = plain.date(from: text) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text)
    }
}
