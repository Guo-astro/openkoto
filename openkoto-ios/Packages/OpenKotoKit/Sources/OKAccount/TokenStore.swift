import Foundation
import Security

/// 会话凭证的存取（`docs/specs/auth-spec.md` §6：iOS / Catalyst 用 Keychain，
/// service = `app.openkoto.account`）。
public protocol TokenStore: Sendable {
    func load() -> StoredSession?
    @discardableResult func save(_ session: StoredSession) -> Bool
    @discardableResult func clear() -> Bool
}

/// Keychain 实现。沿用 `OKAIClient.KeychainStore` 的做法：
/// data-protection keychain + `WhenUnlockedThisDeviceOnly`（不进 iCloud 钥匙串 ——
/// refresh token 绑定的是这台设备，同步到别的设备上只会触发复用检测把两台都踢下线）。
public struct KeychainTokenStore: TokenStore {
    public static let service = "app.openkoto.account"
    public static let account = "session"

    private let service: String
    private let account: String

    public init(service: String = KeychainTokenStore.service, account: String = KeychainTokenStore.account) {
        self.service = service
        self.account = account
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }

    public func load() -> StoredSession? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
            let data = result as? Data
        else { return nil }
        return try? JSONDecoder.session.decode(StoredSession.self, from: data)
    }

    @discardableResult
    public func save(_ session: StoredSession) -> Bool {
        guard let data = try? JSONEncoder.session.encode(session) else { return false }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var add = baseQuery
        add.merge(attributes) { _, new in new }
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    public func clear() -> Bool {
        let status = SecItemDelete(baseQuery as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

/// 测试 / 预览用。
public final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var session: StoredSession?

    public init(_ session: StoredSession? = nil) {
        self.session = session
    }

    public func load() -> StoredSession? {
        lock.withLock { session }
    }

    @discardableResult
    public func save(_ session: StoredSession) -> Bool {
        lock.withLock { self.session = session }
        return true
    }

    @discardableResult
    public func clear() -> Bool {
        lock.withLock { session = nil }
        return true
    }
}

extension JSONEncoder {
    static var session: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return encoder
    }
}

extension JSONDecoder {
    static var session: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        return decoder
    }
}
