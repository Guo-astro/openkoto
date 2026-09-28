#if os(iOS)
import SwiftUI
import OKModels
import OKAIClient
import OKDesignSystem
import OKLocalization
import UIKit
import UserNotifications

/// 设置（设计文档 §6.6）：AI 模型 CRUD + Keychain、外观/主题、学习目标语言、
/// 界面语言、批量并发、复习（SRS 每日上限 + 期望保持率 + 每日提醒）、隐私披露。
struct SettingsView: View {
    @Environment(ThemeManager.self) private var themeManager
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(ContentStore.self) private var store
    @Environment(\.theme) private var theme
    @Environment(\.okCanvas) private var canvas
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    // 由 RootTabView 注入的生效 Locale（跟随界面语言）：用于本地化讲解语言的选项名。
    @Environment(\.locale) private var locale

    @AppStorage("learning.targetLanguage") private var targetLanguage = "zh-CN"
    @AppStorage("app.interfaceLanguage") private var interfaceLanguage = "system"
    @AppStorage("ai.batchConcurrency") private var batchConcurrency = 3
    @AppStorage("srs.dailyNewLimit") private var dailyNewLimit = 20
    @AppStorage("srs.dailyReviewLimit") private var dailyReviewLimit = 100
    @AppStorage("srs.desiredRetention") private var desiredRetention = 0.9
    @AppStorage(ReviewReminder.enabledKey) private var reminderEnabled = false
    @AppStorage(ReviewReminder.minutesKey) private var reminderMinutes = ReviewReminder
        .defaultMinutes
    @AppStorage(OnboardingGate.completedKey) private var onboardingCompleted = false

    @State private var editingConfig: ModelConfig?
    @State private var isAddingConfig = false
    @State private var reminderAuthorization: UNAuthorizationStatus = .notDetermined

    private let retentionOptions: [Double] = [0.80, 0.85, 0.90, 0.95]

    var body: some View {
        @Bindable var themeManager = themeManager
        NavigationStack {
            Form {
                modelsSection

                Section(L("settings.appearance")) {
                    Picker(L("settings.appearance.theme"), selection: $themeManager.themeID) {
                        ForEach(ThemeID.allCases) { themeID in
                            Text(themeID.displayName).tag(themeID)
                        }
                    }
                    Picker(L("settings.appearance.mode"), selection: $themeManager.appearance) {
                        Text(L("settings.appearance.system")).tag(AppearanceMode.system)
                        Text(L("settings.appearance.light")).tag(AppearanceMode.light)
                        Text(L("settings.appearance.dark")).tag(AppearanceMode.dark)
                    }
                }

                Section {
                    // 界面语言：App 菜单/按钮的显示语言（跟随系统 或 en/zh-Hans/ja）。
                    Picker(L("settings.interfaceLanguage"), selection: $interfaceLanguage) {
                        Text(L("settings.interfaceLanguage.system")).tag("system")
                        ForEach(LanguageOptions.interface, id: \.code) { item in
                            Text(item.name).tag(item.code)
                        }
                    }
                    .pickerStyle(.navigationLink)

                    // 讲解语言：AI 生成精讲/翻译所用的语言（复用 learning.targetLanguage）。
                    Picker(L("settings.explanationLanguage"), selection: $targetLanguage) {
                        ForEach(LanguageOptions.target, id: \.self) { code in
                            Text(LanguageOptions.targetDisplayName(code, locale: locale)).tag(code)
                        }
                    }
                    .pickerStyle(.navigationLink)
                } header: {
                    Text(L("settings.language"))
                } footer: {
                    Text(L("settings.language.footer"))
                }

                Section(L("settings.learning")) {
                    Stepper(
                        value: $batchConcurrency, in: 1...6
                    ) {
                        LabeledContent(L("settings.learning.batchConcurrency")) {
                            Text(verbatim: "\(batchConcurrency)")
                        }
                    }
                }

                Section(L("settings.review")) {
                    Stepper(value: $dailyNewLimit, in: 5...100, step: 5) {
                        LabeledContent(L("settings.review.dailyNew")) {
                            Text(verbatim: "\(dailyNewLimit)")
                        }
                    }
                    Stepper(value: $dailyReviewLimit, in: 20...500, step: 10) {
                        LabeledContent(L("settings.review.dailyReview")) {
                            Text(verbatim: "\(dailyReviewLimit)")
                        }
                    }
                    Picker(L("settings.review.retention"), selection: $desiredRetention) {
                        ForEach(retentionOptions, id: \.self) { value in
                            Text(verbatim: "\(Int(value * 100))%").tag(value)
                        }
                    }
                }

                reminderSection

                AccountSection()

                SyncSection()

                DataTransferSection()

                Section {
                    Button {
                        // RootTabView 监听这个 key：置回 false 即回到引导第一步。
                        onboardingCompleted = false
                    } label: {
                        Label(L("settings.replayOnboarding"), systemImage: "sparkles.rectangle.stack")
                    }
                } footer: {
                    Text(L("settings.replayOnboarding.footer"))
                }

                Section(L("settings.privacy")) {
                    Text(L("settings.privacy.note"))
                        .font(.footnote)
                        .foregroundStyle(theme.mutedForeground)
                }

                Section(L("settings.about")) {
                    LabeledContent("OpenKoto iOS") {
                        Text(verbatim: appVersionDescription)
                    }
                    Link(
                        "Privacy Policy",
                        destination: URL(string: "https://www.openkoto.com/privacy-policy")!
                    )
                    Link(
                        "Support",
                        destination: URL(string: "https://github.com/hikariming/OpenKoto/issues")!
                    )
                    Link(
                        "GitHub",
                        destination: URL(string: "https://github.com/hikariming/openkoto")!
                    )
                }
            }
            .scrollContentBackground(.hidden)
            // 表单限宽居中：Form 的行本来就靠系统 inset 撑着，
            // 但 1300pt 宽下「标签 —— 大片空白 —— 控件」还是会拉得两头够不着。
            .frame(maxWidth: canvas.isWide ? 720 : .infinity)
            .frame(maxWidth: .infinity)
            .background(theme.background)
            .sheet(isPresented: $isAddingConfig) {
                ModelConfigFormView(editing: nil).okSheetSizing(.form)
            }
            .sheet(item: $editingConfig) { config in
                ModelConfigFormView(editing: config).okSheetSizing(.form)
            }
            .task { reminderAuthorization = await ReviewReminder.authorizationStatus() }
            // 用户可能刚从系统设置里改完通知权限回来。
            .onChange(of: scenePhase) {
                guard scenePhase == .active else { return }
                Task { reminderAuthorization = await ReviewReminder.authorizationStatus() }
            }
            .onChange(of: reminderEnabled) { Task { await applyReminderChange() } }
            .onChange(of: reminderMinutes) {
                Task { await ReviewReminder.reschedule(favorites: store.favorites) }
            }
        }
    }

    private var appVersionDescription: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String ?? "—"
        return "\(version) (\(build))"
    }

    // MARK: - 每日复习提醒

    /// 提醒时间存的是「距零点的分钟数」，`DatePicker` 要的是 `Date`——这里做转换。
    /// 只取时/分：日期部分是拿今天凑的，排期时会被重新落到每一天上。
    private var reminderTime: Binding<Date> {
        Binding {
            Calendar.current.date(
                bySettingHour: reminderMinutes / 60, minute: reminderMinutes % 60,
                second: 0, of: .now) ?? .now
        } set: { newValue in
            let parts = Calendar.current.dateComponents([.hour, .minute], from: newValue)
            reminderMinutes = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        }
    }

    /// 开着开关但系统那边被拒了——这时什么都不会弹，必须说清楚。
    private var isReminderBlocked: Bool {
        reminderEnabled && reminderAuthorization == .denied
    }

    @ViewBuilder
    private var reminderSection: some View {
        Section {
            Toggle(L("settings.reminder.enabled"), isOn: $reminderEnabled)
            if reminderEnabled {
                DatePicker(
                    L("settings.reminder.time"), selection: reminderTime,
                    displayedComponents: .hourAndMinute)
                // Catalyst 上没有这个 deep link（"app-settings:" 是 iOS 的），
                // 点了什么都不会发生，所以干脆不给按钮——下面的说明文案照常显示。
                #if !targetEnvironment(macCatalyst)
                    if isReminderBlocked {
                        Button(L("settings.reminder.openSystemSettings")) {
                            guard
                                let url = URL(
                                    string: UIApplication.openNotificationSettingsURLString)
                            else { return }
                            openURL(url)
                        }
                    }
                #endif
            }
        } header: {
            Text(L("settings.reminder"))
        } footer: {
            Text(isReminderBlocked ? L("settings.reminder.denied") : L("settings.reminder.footer"))
        }
    }

    /// 开关变化后的处理。
    ///
    /// 被系统拒了**不把开关拨回去**：用户的意图（想要提醒）是明确的，拨回去就丢了，
    /// 等他去系统设置里放行、回到 App 时还得重新想起来再开一次。
    /// 留着开、把话说明白，权限一旦到手，回前台那次重排就自动生效。
    private func applyReminderChange() async {
        if reminderEnabled, await ReviewReminder.authorizationStatus() == .notDetermined {
            _ = await ReviewReminder.requestAuthorization()
        }
        reminderAuthorization = await ReviewReminder.authorizationStatus()
        // 关掉时同样要走一次：reschedule 内部会把已排的全撤掉。
        await ReviewReminder.reschedule(favorites: store.favorites)
    }

    // MARK: - AI 模型配置

    private func modelActions(for config: ModelConfig) -> [OKRowAction] {
        var actions: [OKRowAction] = []
        if !config.isDefault {
            actions.append(
                OKRowAction(
                    title: L("model.form.setDefault"), systemImage: "star", tint: theme.primary
                ) {
                    appConfig.setDefault(config.id)
                })
        }
        actions.append(
            OKRowAction(title: L("common.delete"), systemImage: "trash", role: .destructive) {
                appConfig.delete(config.id)
            })
        return actions
    }

    @ViewBuilder
    private var modelsSection: some View {
        Section {
            if appConfig.configs.isEmpty {
                Label {
                    Text(L("settings.models.none"))
                        .font(.footnote)
                        .foregroundStyle(theme.mutedForeground)
                } icon: {
                    Image(systemName: "key").foregroundStyle(theme.primary)
                }
            } else {
                ForEach(appConfig.configs) { config in
                    Button {
                        editingConfig = config
                    } label: {
                        modelRow(config)
                    }
                    .buttonStyle(.plain)
                    // 必须同时给右键菜单：Mac 上 List 行不支持横扫，
                    // 只写 swipeActions 的话「删除模型」在 Mac 上就没有任何入口了。
                    .okRowActions(trailing: modelActions(for: config))
                }
            }

            Button {
                isAddingConfig = true
            } label: {
                Label(L("settings.models.add"), systemImage: "plus.circle")
            }
        } header: {
            Text(L("settings.models"))
        }
    }

    private func modelRow(_ config: ModelConfig) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(config.name).foregroundStyle(theme.foreground)
                    if config.isDefault {
                        Text(L("model.form.default"))
                            .font(.caption2)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(theme.primary.opacity(0.15))
                            .foregroundStyle(theme.primary)
                            .clipShape(Capsule())
                    }
                }
                Text(verbatim: "\(ProviderCapability.capability(for: config.apiProvider).displayName) · \(config.model)")
                    .font(.caption)
                    .foregroundStyle(theme.mutedForeground)
            }
            Spacer()
            if appConfig.hasKey(for: config.id) {
                Image(systemName: "key.fill")
                    .font(.caption)
                    .foregroundStyle(theme.mutedForeground)
            }
        }
        .contentShape(Rectangle())
    }
}
#endif
