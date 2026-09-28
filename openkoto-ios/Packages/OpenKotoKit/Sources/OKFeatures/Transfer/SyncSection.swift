#if os(iOS)
import OKAccount
import OKDesignSystem
import OKLocalization
import SwiftUI

/// 设置页的「同步」区：同步方式（关闭 / iCloud / OpenKoto 云）、立即同步、状态、迁移。
struct SyncSection: View {
    @Environment(ContentStore.self) private var store
    @Environment(\.theme) private var theme

    @State private var confirmMigration = false

    /// provider 的真相在 UserDefaults 里；`syncStatus` 每次变化都会让 body 重算，
    /// 迁移 / 登录这类由 store 内部发起的切换因此也能反映到选择器上。
    private var provider: Binding<SyncProvider> {
        Binding(
            get: { store.syncProvider },
            set: { newValue in
                guard newValue != store.syncProvider else { return }
                Task { await store.setSyncProvider(newValue) }
            })
    }

    private var isSignedIn: Bool { store.accountSession?.isSignedIn == true }

    var body: some View {
        let current = store.syncProvider
        Section {
            Picker(L("settings.sync.provider"), selection: provider) {
                Text(L("settings.sync.provider.none")).tag(SyncProvider.none)
                Text(L("settings.sync.provider.icloud")).tag(SyncProvider.icloud)
                if store.accountSession != nil {
                    Text(L("settings.sync.provider.openkoto")).tag(SyncProvider.openkoto)
                }
            }
            .disabled(store.syncStatus == .syncing)

            if current != .none {
                Button {
                    Task { await store.syncNow() }
                } label: {
                    Label(L("settings.sync.now"), systemImage: "arrow.triangle.2.circlepath")
                }
                .disabled(store.syncStatus == .syncing)

                // 兜底入口：同步进度走过头之后（CloudKit 的 change token / 服务端游标），
                // 那批记录再也不会被下发，"点一百次立即同步"都没用。
                Button {
                    Task { await store.resyncFromScratch() }
                } label: {
                    Label(L("settings.sync.resync"), systemImage: "arrow.clockwise.icloud")
                }
                .disabled(store.syncStatus == .syncing)

                statusRow
            }

            if current == .icloud && isSignedIn {
                Button {
                    confirmMigration = true
                } label: {
                    Label(L("settings.sync.migrate"), systemImage: "arrow.right.circle")
                }
                .disabled(store.syncStatus == .syncing)
                .confirmationDialog(
                    L("settings.sync.migrate"), isPresented: $confirmMigration,
                    titleVisibility: .visible
                ) {
                    Button(L("settings.sync.migrate.action")) {
                        Task { await store.migrateFromICloudToOpenKoto() }
                    }
                } message: {
                    Text(L("settings.sync.migrate.confirm"))
                }
            }
        } header: {
            Text(L("settings.sync"))
        } footer: {
            switch current {
            case .none: Text(L("settings.sync.footer.none"))
            case .icloud: Text(L("settings.sync.footer.icloud"))
            case .openkoto: Text(L("settings.sync.footer.openkoto"))
            }
        }
    }

    @ViewBuilder
    private var statusRow: some View {
        switch store.syncStatus {
        case .syncing:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(L("settings.sync.status.syncing"))
                    .foregroundStyle(theme.mutedForeground)
            }
        case .idle(let lastSyncedAt):
            Text(
                (lastSyncedAt ?? store.lastSyncedAt).map {
                    String(
                        format: L("settings.sync.lastSynced"),
                        $0.formatted(date: .abbreviated, time: .shortened))
                } ?? L("settings.sync.status.never")
            )
            .font(.footnote)
            .foregroundStyle(theme.mutedForeground)
        case .unavailable:
            // 没登录 iCloud 不是故障，别用红色吓用户。
            Text(L("settings.sync.status.unavailable"))
                .font(.footnote)
                .foregroundStyle(theme.mutedForeground)
        case .signInRequired:
            Text(L("settings.sync.status.signInRequired"))
                .font(.footnote)
                .foregroundStyle(theme.mutedForeground)
        case .quotaExceeded(let count):
            Text(String(format: L("settings.sync.status.quota"), count))
                .font(.footnote)
                .foregroundStyle(theme.destructive)
        case .failed(let detail):
            VStack(alignment: .leading, spacing: 2) {
                Text(L("settings.sync.status.failed"))
                    .font(.footnote)
                    .foregroundStyle(theme.destructive)
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(theme.mutedForeground)
            }
        case .disabled:
            EmptyView()
        }
    }
}
#endif
