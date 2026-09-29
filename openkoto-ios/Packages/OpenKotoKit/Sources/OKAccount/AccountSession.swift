import Foundation
import Observation
import OKPersistence
import os

#if canImport(UIKit)
import UIKit
#endif

/// OpenKoto 账号的界面状态（主线程）。
///
/// 真相在 Keychain 里的 `StoredSession`；这里只是它的可观察投影，
/// 外加 `/me`、设备列表这些只用于展示的数据。
@MainActor
@Observable
public final class AccountSession {
    public private(set) var user: AccountUser?
    public private(set) var plan: Plan = .free
    public private(set) var summary: AccountSummary?
    public private(set) var devices: [DeviceSummary] = []
    public private(set) var isWorking = false
    public private(set) var lastError: String?

    @ObservationIgnored public let api: CloudAPIClient
    @ObservationIgnored public let auth: AuthClient
    @ObservationIgnored public let transport: HTTPSyncTransport
    /// 登录 / 登出之后回调（ContentStore 据此触发同步或清同步状态）。
    @ObservationIgnored public var onSignedIn: (@MainActor () async -> Void)?
    @ObservationIgnored public var onSignedOut: (@MainActor () async -> Void)?

    private let logger = Logger(subsystem: "app.openkoto", category: "Account")

    public var configuration: AccountConfiguration { api.configuration }
    public var isSignedIn: Bool { user != nil }

    public init(api: CloudAPIClient) {
        self.api = api
        self.auth = AuthClient(api: api)
        self.transport = HTTPSyncTransport(api: api)
        if let stored = api.currentSession {
            user = stored.user
            plan = stored.user.plan ?? .free
        }
        Task { [weak self, api] in
            await api.setInvalidationHandler { [weak self] in
                await self?.handleInvalidation()
            }
        }
    }

    public convenience init(
        configuration: AccountConfiguration, tokenStore: any TokenStore = KeychainTokenStore(),
        urlSession: URLSession = .shared
    ) {
        self.init(api: CloudAPIClient(configuration: configuration, tokenStore: tokenStore, session: urlSession))
    }

    /// 主 App 用：基址读 Info.plist，令牌存 Keychain。
    public static func live() -> AccountSession {
        AccountSession(configuration: .fromBundle(deviceName: currentDeviceName()))
    }

    static func currentDeviceName() -> String {
        #if targetEnvironment(macCatalyst)
        return ProcessInfo.processInfo.hostName.replacingOccurrences(of: ".local", with: "")
        #elseif canImport(UIKit)
        return UIDevice.current.name
        #else
        return Host.current().localizedName ?? "Mac"
        #endif
    }

    // MARK: - 登录

    /// 网页授权码登录的第二步：拿回调 URL 换令牌。
    public func completeWebSignIn(callback: URL, request: AuthorizationRequest) async {
        await perform {
            let code = try AuthClient.authorizationCode(from: callback, expectedState: request.state)
            let session = try await self.auth.exchange(code: code, verifier: request.pkce.verifier)
            await self.didSignIn(session)
        }
    }

    /// Sign in with Apple 拿到 identityToken 之后调用。
    public func signInWithApple(
        identityToken: String, rawNonce: String, fullName: AuthClient.AppleFullName?
    ) async {
        await perform {
            let session = try await self.auth.signInWithApple(
                identityToken: identityToken, rawNonce: rawNonce, fullName: fullName)
            await self.didSignIn(session)
        }
    }

    private func didSignIn(_ session: StoredSession) async {
        user = session.user
        plan = session.user.plan ?? .free
        await refreshAccount()
        await onSignedIn?()
    }

    public func reportError(_ message: String?) {
        lastError = message
    }

    // MARK: - 账号信息

    /// 拉 `/me` 与设备列表。失败只记错误，不影响已登录状态（离线时很常见）。
    public func refreshAccount() async {
        guard isSignedIn else { return }
        do {
            let summary = try await auth.me()
            self.summary = summary
            plan = summary.plan
            devices = try await auth.devices()
            lastError = nil
        } catch let error as CloudAPIError where error.requiresSignIn {
            await handleInvalidation()
        } catch {
            logger.error("refresh account failed: \(error.localizedDescription, privacy: .public)")
            lastError = error.localizedDescription
        }
    }

    public func revokeDevice(_ device: DeviceSummary) async {
        await perform {
            try await self.auth.revokeDevice(id: device.id)
            if device.current {
                await self.signOut()
            } else {
                self.devices.removeAll { $0.id == device.id }
            }
        }
    }

    // MARK: - 登出

    /// 吊销本设备的 refresh token 并清 Keychain。**本地学习数据不动。**
    public func signOut() async {
        isWorking = true
        await auth.logout()
        clearState()
        isWorking = false
        await onSignedOut?()
    }

    private func handleInvalidation() async {
        guard user != nil else { return }
        clearState()
        await onSignedOut?()
    }

    private func clearState() {
        user = nil
        plan = .free
        summary = nil
        devices = []
    }

    private func perform(_ work: @escaping @MainActor () async throws -> Void) async {
        isWorking = true
        lastError = nil
        defer { isWorking = false }
        do {
            try await work()
        } catch AuthError.cancelled {
            // 用户自己关掉了登录页，不是错误。
        } catch {
            logger.error("account operation failed: \(error.localizedDescription, privacy: .public)")
            lastError = error.localizedDescription
        }
    }
}
