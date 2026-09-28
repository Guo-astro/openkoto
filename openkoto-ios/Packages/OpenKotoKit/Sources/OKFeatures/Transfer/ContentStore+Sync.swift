import Foundation
import OKAccount
import OKModels
import OKPersistence

/// 跨设备同步的方式。
///
/// 三选一，**CloudKit 与 OpenKoto 云永远不同时启用**：两套引擎各自维护水位线与
/// 逐条元数据，同时跑的话同一条修改会被推两遍、两边的冲突合并还会互相顶。
public enum SyncProvider: String, CaseIterable, Sendable {
    case none
    case icloud
    case openkoto
}

/// 同步的接线（iCloud：跨设备同步 P3；OpenKoto 云：P1 iOS）。
///
/// **同步是增强，不是依赖**：关掉、没登录、或者根本没有网络时，
/// App 的每一个功能都必须照常可用。所以这里所有失败都只记状态，不阻断任何流程。
extension ContentStore {
    /// 状态本身不依赖 CloudKit，放在条件编译之外 ——
    /// `ContentStore` 在 macOS 上也要编译（`swift test` 跑的就是那一份）。
    public enum SyncStatus: Sendable, Equatable {
        case disabled
        case idle(lastSyncedAt: Date?)
        case syncing
        /// 没登录 iCloud / 账号不可用。这不是错误，是一种正常状态，
        /// 文案上要区别于"同步失败"。
        case unavailable
        /// 选了 OpenKoto 云但没登录（或登录已失效）。
        case signInRequired
        /// 有记录因超出套餐配额没能上传（本地数据完好）。
        case quotaExceeded(count: Int)
        case failed(String)
    }

    /// 同步方式（`none` / `icloud` / `openkoto`）。
    public static let syncProviderKey = "sync.provider"
    /// 旧版的 iCloud 开关。只读来做一次性迁移，之后与 provider 保持一致写入
    /// （降级回旧版时 iCloud 用户的开关不丢）。
    public static let syncEnabledKey = "sync.iCloudEnabled"
    static let lastSyncedAtKey = "sync.lastSyncedAt"

    /// 当前同步方式。没设置过时从旧开关推断：开着 iCloud 的老用户继续用 iCloud。
    /// 默认**关闭**：把用户的学习记录传到云上这件事，必须由他自己点头。
    public var syncProvider: SyncProvider {
        Self.syncProvider(in: defaults)
    }

    static func syncProvider(in defaults: UserDefaults) -> SyncProvider {
        if let raw = defaults.string(forKey: syncProviderKey),
            let provider = SyncProvider(rawValue: raw)
        {
            return provider
        }
        return defaults.bool(forKey: syncEnabledKey) ? .icloud : .none
    }

    /// 把旧开关落成新键（幂等）。
    static func migrateSyncProvider(in defaults: UserDefaults) {
        guard defaults.string(forKey: syncProviderKey) == nil else { return }
        defaults.set(syncProvider(in: defaults).rawValue, forKey: syncProviderKey)
    }

    public var isSyncEnabled: Bool { syncProvider != .none }

    public var lastSyncedAt: Date? {
        defaults.object(forKey: Self.lastSyncedAtKey) as? Date
    }

    /// 切换同步方式。
    ///
    /// 关闭 / 切走时**不删本地任何数据**，也不删云端的 —— 用户只是不想再传了，
    /// 不是要放弃自己的学习记录。
    public func setSyncProvider(_ provider: SyncProvider, syncImmediately: Bool = true) async {
        Self.migrateSyncProvider(in: defaults)
        if provider != cloudSyncEngineProvider {
            // 先丢掉旧引擎（CKSyncEngine 随之释放、停止自动调度），再启用新的。
            cloudSyncEngine = nil
            cloudSyncEngineProvider = nil
        }
        defaults.set(provider.rawValue, forKey: Self.syncProviderKey)
        defaults.set(provider == .icloud, forKey: Self.syncEnabledKey)
        if provider == .none {
            syncStatus = .disabled
        } else if syncImmediately {
            await syncNow()
        } else {
            syncStatus = .idle(lastSyncedAt: lastSyncedAt)
        }
    }

    /// 旧的 iCloud 开关（保留给还在用它的界面）。
    public func setSyncEnabled(_ enabled: Bool) async {
        await setSyncProvider(enabled ? .icloud : .none)
    }

    /// 手动同步一次：先拉后推。
    ///
    /// 顺序是刻意的 —— 先把别的设备的变更拉回来合并，再推本地的，
    /// 这样本地推上去的已经是合并后的结果，少一轮往返。
    public func syncNow() async {
        let provider = syncProvider
        guard provider != .none else {
            syncStatus = .disabled
            return
        }
        // 同一时刻只跑一轮（前台回来 + 手动点按钮会撞在一起）。
        guard syncStatus != .syncing else { return }
        guard let engine = await syncEngine(for: provider) else {
            syncStatus = provider == .openkoto ? .signInRequired : .unavailable
            return
        }

        syncStatus = .syncing
        do {
            try await engine.pull()
            try await engine.push()
            await load()
            let now = Date()
            defaults.set(now, forKey: Self.lastSyncedAtKey)
            syncStatus = .idle(lastSyncedAt: now)
        } catch {
            await load()
            syncStatus = syncStatus(for: error, provider: provider)
        }
    }

    /// 丢掉同步进度，下一次同步把云端的东西全量重新拉一遍（OpenKoto 云还会全量推一遍）。
    ///
    /// **不删本地任何数据**，只清同步进度。给"云上明明有、这台就是没有"兜底。
    public func resyncFromScratch() async {
        let provider = syncProvider
        guard provider != .none else { return }
        guard let engine = await syncEngine(for: provider) else {
            syncStatus = provider == .openkoto ? .signInRequired : .unavailable
            return
        }
        do {
            try await resetSyncState(of: engine)
        } catch {
            syncStatus = syncStatus(for: error, provider: provider)
            return
        }
        // 引擎状态作废了，缓存的那个也一起丢掉，下一轮重建。
        cloudSyncEngine = nil
        cloudSyncEngineProvider = nil
        await syncNow()
    }

    /// 一次性迁移：iCloud → OpenKoto 云（设计文档 §5.7）。
    ///
    /// 1. 先完成一次 CloudKit pull，确保本机是最新的；
    /// 2. 切到 OpenKoto 云（CloudKit 引擎随之释放 —— 两个引擎不同时启用）；
    /// 3. 清掉 HTTP 同步进度，按"新用户"流程全量拉、全量推。
    ///
    /// CloudKit 拉取失败就**停在原地**：带着不完整的本地数据迁过去，
    /// 等于把别的设备上还没同步过来的修改永久留在 iCloud 里。
    public func migrateFromICloudToOpenKoto() async {
        guard syncEngineFactory != nil || accountSession?.isSignedIn == true else {
            syncStatus = .signInRequired
            return
        }
        guard syncStatus != .syncing else { return }
        syncStatus = .syncing
        if let icloud = await syncEngine(for: .icloud) {
            do {
                try await icloud.pull()
            } catch {
                syncStatus = syncStatus(for: error, provider: .icloud)
                return
            }
        }
        syncStatus = .idle(lastSyncedAt: lastSyncedAt)
        await setSyncProvider(.openkoto, syncImmediately: false)
        guard let engine = await syncEngine(for: .openkoto) else {
            syncStatus = .signInRequired
            return
        }
        do {
            try await resetSyncState(of: engine)
        } catch {
            syncStatus = syncStatus(for: error, provider: .openkoto)
            return
        }
        await syncNow()
    }

    /// 账号登录成功：没开同步的直接启用 OpenKoto 云；已经在用的立刻同步一次。
    /// 正在用 iCloud 的**不自动切**——那要走迁移（设置页有按钮）。
    public func accountDidSignIn() async {
        switch syncProvider {
        case .none: await setSyncProvider(.openkoto)
        case .openkoto:
            cloudSyncEngine = nil
            cloudSyncEngineProvider = nil
            await syncNow()
        case .icloud: break
        }
    }

    /// 账号登出 / 失效：HTTP 引擎作废。provider 保持不变，重新登录后接着同步。
    public func accountDidSignOut() async {
        guard syncProvider == .openkoto else { return }
        if cloudSyncEngineProvider == .openkoto {
            cloudSyncEngine = nil
            cloudSyncEngineProvider = nil
        }
        syncStatus = .signInRequired
    }

    // MARK: - 引擎

    /// 取（或建）指定 provider 的引擎。换 provider 时旧引擎先释放。
    func syncEngine(for provider: SyncProvider) async -> (any SyncEngine)? {
        if cloudSyncEngineProvider == provider, let existing = cloudSyncEngine { return existing }
        let engine: (any SyncEngine)?
        if let syncEngineFactory {
            engine = await syncEngineFactory(provider)
        } else {
            engine = await makeProductionSyncEngine(for: provider)
        }
        // 只缓存当前选中的那个；迁移时临时建的 CloudKit 引擎用完即弃。
        if provider == syncProvider {
            cloudSyncEngine = engine
            cloudSyncEngineProvider = engine == nil ? nil : provider
        }
        return engine
    }

    private func makeProductionSyncEngine(for provider: SyncProvider) async -> (any SyncEngine)? {
        switch provider {
        case .none:
            return nil
        case .openkoto:
            guard let accountSession, accountSession.isSignedIn else { return nil }
            return HTTPSyncEngine(repository: repository, transport: accountSession.transport)
        case .icloud:
            #if os(iOS)
            guard #available(iOS 17.0, macOS 14.0, *) else { return nil }
            return await makeCloudKitEngine()
            #else
            return nil
            #endif
        }
    }

    private func resetSyncState(of engine: any SyncEngine) async throws {
        if let http = engine as? HTTPSyncEngine {
            try await http.resetSyncState()
            return
        }
        #if os(iOS)
        if #available(iOS 17.0, macOS 14.0, *), let cloudKit = engine as? CloudKitSyncEngine {
            try await cloudKit.resetSyncState()
        }
        #endif
    }

    private func syncStatus(for error: Error, provider: SyncProvider) -> SyncStatus {
        if case HTTPSyncError.quotaExceeded(let count) = error {
            return .quotaExceeded(count: count)
        }
        if let apiError = error as? CloudAPIError {
            if apiError.requiresSignIn { return .signInRequired }
            Self.logger.error("sync failed: \(apiError.localizedDescription, privacy: .public)")
            return .failed(apiError.localizedDescription)
        }
        #if os(iOS)
        if provider == .icloud {
            if let ckError = error as? CKError, ckError.code == .notAuthenticated {
                // 没登录 iCloud：不是故障，别用红色错误吓用户。
                return .unavailable
            }
            // 完整展开而不是 localizedDescription：CloudKit 的那句
            // "The operation couldn't be completed. (CKErrorDomain error 15.)"
            // 既没说 15 是什么，也没说服务端到底拒绝了什么。
            let report = CloudKitErrorReport.describe(error)
            Self.logger.error("sync failed: \(report, privacy: .public) | raw: \(error)")
            return .failed(report)
        }
        #endif
        Self.logger.error("sync failed: \(error.localizedDescription, privacy: .public)")
        return .failed(error.localizedDescription)
    }
}

#if os(iOS)
import CloudKit
import UIKit

extension ContentStore {
    /// 向 APNs 注册。
    ///
    /// **CKSyncEngine 一初始化就会去创建数据库订阅，而订阅要绑定推送 topic。**
    /// 没注册过的话服务端拒绝建订阅，报出来是
    /// `serverRejectedRequest (15) / CKInternalErrorDomain 2000`，
    /// 日志里那句 `error saving subscriptions` 才是真正的线索。
    ///
    /// 不需要向用户申请通知权限：CloudKit 用的是静默推送，
    /// `registerForRemoteNotifications()` 单独调用不会弹任何框。
    @MainActor
    private func registerForSilentPushIfNeeded() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    @available(iOS 17.0, macOS 14.0, *)
    fileprivate func makeCloudKitEngine() async -> CloudKitSyncEngine? {
        await registerForSilentPushIfNeeded()
        // 账号不可用时不要建引擎：它一建出来就会自行调度，
        // 只会不断产生注定失败的请求。
        let status = try? await CKContainer(
            identifier: CloudKitSyncEngine.containerIdentifier
        ).accountStatus()
        guard status == .available else { return nil }
        return CloudKitSyncEngine(repository: repository)
    }
}
#endif
