import Foundation
import OKPersistence
import Testing

@testable import OKFeatures

/// 同步方式的切换（none / iCloud / OpenKoto 云）。
///
/// 核心约束：**两套引擎永远不同时在跑**；从旧的 iCloud 开关平滑迁移；
/// 迁移到 OpenKoto 云时先完成 CloudKit pull。
@MainActor
@Suite struct SyncProviderTests {
    final class FakeEngine: SyncEngine, @unchecked Sendable {
        let name: String
        let journal: Journal
        var pullError: Error?
        var pushError: Error?

        init(_ name: String, journal: Journal) {
            self.name = name
            self.journal = journal
        }

        func pull() async throws {
            journal.append("\(name).pull")
            if let pullError { throw pullError }
        }

        func push() async throws {
            journal.append("\(name).push")
            if let pushError { throw pushError }
        }
    }

    final class Journal: @unchecked Sendable {
        private let lock = NSLock()
        private var _entries: [String] = []
        var entries: [String] { lock.withLock { _entries } }
        func append(_ entry: String) { lock.withLock { _entries.append(entry) } }
    }

    private func makeStore() throws -> (ContentStore, UserDefaults, Journal, [SyncProvider: FakeEngine]) {
        let suite = "SyncProviderTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        let store = ContentStore(
            repository: ContentRepository(database: try AppDatabase.inMemory()), defaults: defaults)
        let journal = Journal()
        let engines: [SyncProvider: FakeEngine] = [
            .icloud: FakeEngine("icloud", journal: journal),
            .openkoto: FakeEngine("openkoto", journal: journal),
        ]
        store.syncEngineFactory = { provider in
            journal.append("make.\(provider.rawValue)")
            return engines[provider]
        }
        return (store, defaults, journal, engines)
    }

    @Test func legacyICloudToggleMapsToTheICloudProvider() throws {
        let (store, defaults, _, _) = try makeStore()
        #expect(store.syncProvider == .none)
        defaults.set(true, forKey: ContentStore.syncEnabledKey)
        #expect(store.syncProvider == .icloud)
        ContentStore.migrateSyncProvider(in: defaults)
        #expect(defaults.string(forKey: ContentStore.syncProviderKey) == "icloud")
        // 迁移后新键说了算
        defaults.set(false, forKey: ContentStore.syncEnabledKey)
        #expect(store.syncProvider == .icloud)
    }

    @Test func syncUsesOnlyTheSelectedEngine() async throws {
        let (store, _, journal, _) = try makeStore()
        await store.setSyncProvider(.openkoto)
        #expect(journal.entries == ["make.openkoto", "openkoto.pull", "openkoto.push"])
        guard case .idle = store.syncStatus else {
            Issue.record("expected idle, got \(store.syncStatus)")
            return
        }
        await store.syncNow()
        #expect(!journal.entries.contains { $0.hasPrefix("icloud") })
        #expect(journal.entries.filter { $0 == "make.openkoto" }.count == 1, "引擎复用，不每次重建")
    }

    @Test func switchingProvidersDropsTheOldEngine() async throws {
        let (store, defaults, journal, _) = try makeStore()
        await store.setSyncProvider(.icloud)
        await store.setSyncProvider(.openkoto)
        await store.syncNow()
        let afterSwitch = journal.entries.drop { $0 != "make.openkoto" }
        #expect(!afterSwitch.contains { $0.hasPrefix("icloud") }, "切走之后 iCloud 引擎不能再被调用")
        #expect(store.cloudSyncEngineProvider == .openkoto)
        #expect(defaults.bool(forKey: ContentStore.syncEnabledKey) == false)

        await store.setSyncProvider(.none)
        #expect(store.syncStatus == .disabled)
        #expect(store.cloudSyncEngine == nil)
    }

    @Test func migrationPullsFromICloudFirstThenSyncsToOpenKoto() async throws {
        let (store, _, journal, _) = try makeStore()
        await store.setSyncProvider(.icloud, syncImmediately: false)
        await store.migrateFromICloudToOpenKoto()
        #expect(store.syncProvider == .openkoto)
        let entries = journal.entries
        let pullIndex = try #require(entries.firstIndex(of: "icloud.pull"))
        let httpIndex = try #require(entries.firstIndex(of: "openkoto.pull"))
        #expect(pullIndex < httpIndex)
        #expect(!entries.contains("icloud.push"), "迁移不往 iCloud 推任何东西")
        #expect(entries.contains("openkoto.push"))
    }

    @Test func failedICloudPullAbortsTheMigration() async throws {
        let (store, _, journal, engines) = try makeStore()
        await store.setSyncProvider(.icloud, syncImmediately: false)
        engines[.icloud]?.pullError = URLError(.notConnectedToInternet)
        await store.migrateFromICloudToOpenKoto()
        #expect(store.syncProvider == .icloud)
        #expect(!journal.entries.contains { $0.hasPrefix("openkoto") })
        guard case .failed = store.syncStatus else {
            Issue.record("expected failure, got \(store.syncStatus)")
            return
        }
    }

    @Test func quotaErrorsAreSurfacedDistinctly() async throws {
        let (store, _, _, engines) = try makeStore()
        engines[.openkoto]?.pushError = HTTPSyncError.quotaExceeded(count: 3)
        await store.setSyncProvider(.openkoto)
        #expect(store.syncStatus == .quotaExceeded(count: 3))
    }

    @Test func openKotoWithoutAnAccountAsksForSignIn() async throws {
        let suite = "SyncProviderTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = ContentStore(
            repository: ContentRepository(database: try AppDatabase.inMemory()), defaults: defaults)
        await store.setSyncProvider(.openkoto)
        #expect(store.syncStatus == .signInRequired)
        defaults.removePersistentDomain(forName: suite)
    }

    @Test func signingInEnablesOpenKotoWhenSyncWasOff() async throws {
        let (store, _, journal, _) = try makeStore()
        await store.accountDidSignIn()
        #expect(store.syncProvider == .openkoto)
        #expect(journal.entries.contains("openkoto.push"))

        await store.accountDidSignOut()
        #expect(store.syncStatus == .signInRequired)
        #expect(store.syncProvider == .openkoto, "重新登录后接着同步")
    }

    @Test func signingInDoesNotHijackICloudUsers() async throws {
        let (store, _, journal, _) = try makeStore()
        await store.setSyncProvider(.icloud, syncImmediately: false)
        await store.accountDidSignIn()
        #expect(store.syncProvider == .icloud)
        #expect(!journal.entries.contains { $0.hasPrefix("openkoto") })
    }
}
