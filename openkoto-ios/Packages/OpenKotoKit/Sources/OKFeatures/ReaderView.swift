#if os(iOS)
import SwiftUI
import OKModels
import OKDesignSystem
import OKLocalization

enum ReaderViewMode: String, CaseIterable, Identifiable {
    case original
    case bilingual
    case translation

    var id: String { rawValue }

    var titleKey: String.LocalizationValue {
        switch self {
        case .original: "reader.mode.original"
        case .bilingual: "reader.mode.bilingual"
        case .translation: "reader.mode.translation"
        }
    }
}

/// 阅读器（核心屏幕，设计文档 §6.4）：
/// 段落 LazyVStack 虚拟化 + 段内 FlowLayout 逐句 chip，点句展开精讲。
/// 精讲的形态由画布宽度决定——窄屏半屏 sheet（正文仍可滚动换句），
/// 宽屏右侧常驻分栏（正文完全不被遮挡），见 `adaptiveDetailPane`。
struct ReaderView: View {
    @Environment(ContentStore.self) private var store
    @Environment(\.theme) private var theme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.okCanvas) private var canvas

    let article: Article
    /// 从搜索结果进来时定位到的句序。`NativeChapterView.restoreOrder` 已支持滚到指定句，
    /// 这里只是把值传下去。
    var initialSegmentOrder: Int?

    @AppStorage("reader.fontSize") private var fontSize: Double = 18
    /// 词级读音开关。与三种视图模式正交（哪种模式下都可能想看读音），所以不做成第四种 mode。
    @AppStorage("reader.showReading") private var showReading = false
    /// 宽屏下收起右侧精讲栏，把整片宽度还给正文（沉浸阅读）。窄屏无意义，按钮也不出现。
    @AppStorage("reader.paneCollapsed") private var paneCollapsed = false
    @State private var viewMode: ReaderViewMode = .original
    @State private var selectedSegmentID: UUID?

    private var segments: [ArticleSegment] {
        store.segments(for: article.id)
    }

    private var readingRuns: [UUID: [ReadingRun]] {
        showReading ? store.readingRuns(for: article.id) : [:]
    }

    /// 这篇文章有没有可显示的读音。没有时把开关灰掉并说明，好过让用户点了没反应。
    private var hasReadings: Bool { !store.readingRuns(for: article.id).isEmpty }

    /// 歌词且带时间轴：按行列出、左侧显示时间（复用媒体页的字幕列表）。
    /// 没有时间轴的歌词（纯文本）照普通文章排版。
    private var isTimedLyrics: Bool {
        article.sourceType == .lyrics && segments.contains { $0.startTime != nil }
    }

    @ViewBuilder
    private var content: some View {
        if isTimedLyrics {
            SubtitleListView(
                segments: segments,
                activeID: nil,
                isInGap: false,
                selectedID: selectedSegmentID,
                loopingID: nil,
                readingRuns: readingRuns,
                fontSize: fontSize,
                viewMode: viewMode,
                isBlind: false,
                revealedID: nil,
                onTap: { selectedSegmentID = $0.id },
                onExplain: { selectedSegmentID = $0.id },
                onToggleLoop: { _ in },
                showsLoop: false)
        } else {
            NativeChapterView(
                segments: segments,
                selectedSegmentID: $selectedSegmentID,
                fontSize: fontSize,
                viewMode: viewMode,
                restoreOrder: initialSegmentOrder,
                readingRuns: readingRuns
            )
        }
    }

    var body: some View {
        content
        .background(theme.background)
        .safeAreaInset(edge: .bottom) { batchBar }
        // 句子按需加载：启动时只查计数，进阅读器才把这篇的句子读进内存。
        .task(id: article.id) {
            await store.openArticle(article.id)
            // 截图/UI 测试用：自动选中第一句（含预置精讲）。
            // 必须等 openArticle 之后——句子现在是懒加载的，onAppear 时还是空的。
            if ProcessInfo.processInfo.arguments.contains("-prototypeDemo") {
                selectedSegmentID = segments.first?.id
            }
        }
        .readingClock(articleID: article.id)
        // 挂在导航修饰之前：底部的 batchBar 留在左栏，导航栏横跨两栏。
        .explanationPane(
            article: article, selection: $selectedSegmentID, isCollapsed: paneCollapsed)
        .navigationTitle(article.title)
        .navigationBarTitleDisplayMode(.inline)
        // 阅读时收起底部 tab 栏：正文多一行，返回上一级会自动恢复。
        // 宽屏不收——那边的主导航是侧边栏，藏掉用户就出不去了。
        .hidesAppTabBar()
        .toolbar { readerToolbar }
    }

    // MARK: - 批量任务进度条

    private var batchBar: some View {
        BatchProgressBar(articleID: article.id)
    }

    // MARK: - 工具栏

    @ToolbarContentBuilder
    private var readerToolbar: some ToolbarContent {
        // 只有宽屏才有右栏可收。窄屏走 sheet，收起是没有意义的概念。
        if canvas.isWide {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    withAnimation(.snappy) { paneCollapsed.toggle() }
                } label: {
                    Image(systemName: "sidebar.right")
                        .foregroundStyle(paneCollapsed ? theme.mutedForeground : theme.primary)
                }
                .accessibilityLabel(
                    Text(paneCollapsed ? L("reader.pane.expand") : L("reader.pane.collapse")))
                .accessibilityAddTraits(paneCollapsed ? [] : .isSelected)
            }
        }
        // 常驻按钮：唱歌/跟读时要频繁开关，藏进菜单太深。
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                showReading.toggle()
            } label: {
                Image(systemName: "character.phonetic")
                    .foregroundStyle(showReading ? theme.primary : theme.mutedForeground)
            }
            .disabled(!hasReadings)
            .accessibilityLabel(Text(L("reader.showReading")))
            .accessibilityAddTraits(showReading ? .isSelected : [])
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Section {
                    Toggle(isOn: $showReading) {
                        Label(L("reader.showReading"), systemImage: "character.phonetic")
                    }
                    .disabled(!hasReadings)
                } header: {
                    if !hasReadings { Text(L("reader.reading.unavailable")) }
                }
                let progress = store.progress(for: article.id)
                let running = store.isBatchRunning(articleID: article.id)
                Section {
                    Button {
                        store.batchExplainAll(articleID: article.id)
                    } label: {
                        Label(L("reader.batch.explainAll"), systemImage: "sparkles")
                    }
                    .disabled(running || progress.explained >= progress.total)
                    Button {
                        store.batchTranslateAll(articleID: article.id)
                    } label: {
                        Label(L("reader.batch.translateAll"), systemImage: "character.book.closed")
                    }
                    .disabled(running)
                }
                Picker(selection: $viewMode, label: Text("")) {
                    ForEach(ReaderViewMode.allCases) { mode in
                        Text(L(mode.titleKey)).tag(mode)
                    }
                }
                Section(L("reader.fontSize")) {
                    Stepper(
                        value: $fontSize,
                        in: 12...32,
                        step: 2
                    ) {
                        Text(verbatim: "\(Int(fontSize)) pt")
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }
}
#endif
