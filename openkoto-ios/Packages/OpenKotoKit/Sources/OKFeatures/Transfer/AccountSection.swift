#if os(iOS)
import AuthenticationServices
import OKAccount
import OKDesignSystem
import OKLocalization
import SwiftUI

#if !targetEnvironment(macCatalyst)
import SafariServices
#endif

/// 设置页的「OpenKoto 账号」区：登录（Apple / 网页）、账号与套餐、设备、登出、删除账号。
struct AccountSection: View {
    @Environment(ContentStore.self) private var store
    @Environment(\.theme) private var theme
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.openURL) private var openURL

    @State private var appleFlow = AppleSignInFlow()
    @State private var confirmSignOut = false
    @State private var safariURL: SafariDestination?

    var body: some View {
        if let account = store.accountSession {
            content(account)
        }
    }

    @ViewBuilder
    private func content(_ account: AccountSession) -> some View {
        Section {
            if let user = account.user {
                signedIn(account, user: user)
            } else {
                SignInWithAppleButton(.signIn) { request in
                    appleFlow.configure(request)
                } onCompletion: { result in
                    Task { await appleFlow.complete(result, session: account) }
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .frame(height: 44)
                .disabled(account.isWorking)

                Button {
                    Task { await account.signInWithWeb() }
                } label: {
                    Label(L("settings.account.signInWeb"), systemImage: "envelope")
                }
                .disabled(account.isWorking)
            }

            if account.isWorking {
                ProgressView().controlSize(.small)
            }
            if let error = account.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(theme.destructive)
            }
        } header: {
            Text(L("settings.account"))
        } footer: {
            Text(account.isSignedIn ? L("settings.account.delete.footer") : L("settings.account.footer"))
        }
        .task { await account.refreshAccount() }
        .sheet(item: $safariURL) { destination in
            SafariView(url: destination.url).ignoresSafeArea()
        }
    }

    @ViewBuilder
    private func signedIn(_ account: AccountSession, user: AccountUser) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: user.email)
                if let name = user.name, !name.isEmpty, name != user.email {
                    Text(verbatim: name)
                        .font(.caption)
                        .foregroundStyle(theme.mutedForeground)
                }
            }
        } icon: {
            Image(systemName: "person.crop.circle")
        }

        LabeledContent(L("settings.account.plan")) {
            Text(verbatim: account.plan.rawValue.capitalized)
        }

        if let pending = account.summary?.pendingDeletion {
            Text(
                String(
                    format: L("settings.account.pendingDeletion"),
                    (ISO8601DateFormatter().date(from: pending) ?? .now)
                        .formatted(date: .abbreviated, time: .omitted))
            )
            .font(.footnote)
            .foregroundStyle(theme.destructive)
        }

        if !account.devices.isEmpty {
            DisclosureGroup(L("settings.account.devices")) {
                ForEach(account.devices) { device in
                    deviceRow(device, account: account)
                }
            }
        }

        Button {
            open(account.configuration.accountURL)
        } label: {
            Label(L("settings.account.manage"), systemImage: "safari")
        }

        Button(role: .destructive) {
            confirmSignOut = true
        } label: {
            Label(L("settings.account.signOut"), systemImage: "rectangle.portrait.and.arrow.right")
        }
        .confirmationDialog(
            L("settings.account.signOut"), isPresented: $confirmSignOut, titleVisibility: .visible
        ) {
            Button(L("settings.account.signOut"), role: .destructive) {
                Task { await account.signOut() }
            }
        } message: {
            Text(L("settings.account.signOut.confirm"))
        }

        // App Store 要求应用内提供删除入口；服务端只接受网页会话发起删除
        // （需要最近重新认证），所以这里打开账户页的删除流程。
        Button(role: .destructive) {
            open(account.configuration.accountDeletionURL)
        } label: {
            Label(L("settings.account.delete"), systemImage: "trash")
        }
    }

    private func deviceRow(_ device: DeviceSummary, account: AccountSession) -> some View {
        HStack {
            Image(systemName: Self.icon(for: device.platform))
                .foregroundStyle(theme.mutedForeground)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: device.name)
                Group {
                    if device.current {
                        Text(L("settings.account.device.current"))
                    } else if let seen = device.lastSeenDate {
                        Text(seen.formatted(date: .abbreviated, time: .shortened))
                    }
                }
                .font(.caption)
                .foregroundStyle(theme.mutedForeground)
            }
            Spacer()
            if !device.current {
                Menu {
                    Button(L("settings.account.device.revoke"), role: .destructive) {
                        Task { await account.revokeDevice(device) }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
    }

    private static func icon(for platform: String) -> String {
        switch platform {
        case "ios": return "iphone"
        case "macos": return "laptopcomputer"
        case "windows", "linux": return "desktopcomputer"
        case "web": return "globe"
        case "cli": return "terminal"
        default: return "questionmark.circle"
        }
    }

    private func open(_ url: URL) {
        #if targetEnvironment(macCatalyst)
        openURL(url)
        #else
        safariURL = SafariDestination(url: url)
        #endif
    }
}

private struct SafariDestination: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

#if !targetEnvironment(macCatalyst)
private struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
#else
private struct SafariView: View {
    let url: URL
    var body: some View { EmptyView() }
}
#endif
#endif
