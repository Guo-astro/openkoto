#if os(iOS)
import SwiftUI
import OKModels
import OKBooks
import OKDesignSystem
import OKLocalization

/// 书籍阅读器：按章复用 `NativeChapterView`，另加目录、翻章与续读位置。
///
/// 与 `ReaderView` 的分工：单篇文章没有章节和续读概念，这里才有。
/// 逐句 chip、精讲弹窗、批量任务都走同一套实现，不做第二份。
struct BookReaderView: View {
    @Environment(ContentStore.self) private var store
    @Environment(\.theme) private var theme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.okCanvas) private var canvas

    let book: Book
    /// 从搜索结果进来时的落点（章 + 句序）。有值时压过续读位置——
    /// 用户点的是"这一句"，不是"上次读到哪"。
    var initialChapterIndex: Int?
    var initialSegmentOrder: Int?

    @AppStorage("reader.fontSize") private var fontSize: Double = 18
    /// 与 ReaderView 共用同一个 key：读音开关是全局阅读偏好，不该按书记忆。
    @AppStorage("reader.showReading") private var showReading = false
    /// 同上，精讲栏收起状态也是全局阅读偏好。
    @AppStorage("reader.paneCollapsed") private var paneCollapsed = false
    /// 划词操作条的实测宽度与所在容器宽度，用于把它夹在可视区内。
    @State private var selectionBarWidth: CGFloat = 0
    @State private var readerWidth: CGFloat = 0
    @State private var viewMode: ReaderViewMode = .original
    @State private var selectedSegmentID: UUID?
    @State private var chapterIndex = 0
    @State private var showChapters = false
    /// 本章当前视口顶部的句序，节流后落库。
    @State private var visibleOrder = 0
    @State private var restoreOrder: Int?
    @State private var lastSavedAt: Date?
    @State private var renderMode: BookRenderMode = .native
    @State private var scrollFraction: Double = 0
    @State private var webSelection: OriginalLayoutView.WebSelection?
    /// 划词收藏时预填到生词编辑表的词形。
    @State private var pendingWord: String?
    /// 划词所在的句子——走的是 `addHighlight` 同一套重锚，不写第二份定位。
    @State private var pendingSegmentID: UUID?
    @State private var showBookmarks = false

    /// 位置写库的最小间隔——翻页时每帧都写没有意义。
    private static let saveInterval: TimeInterval = 3

    private var chapters: [BookChapterSummary] {
        store.chapterSummaries(of: book.id)
    }

    /// 本章有没有可显示的读音（语种不支持 / 全是假名时为空）。
    private var hasReadings: Bool {
        guard let chapter = currentChapter else { return false }
        return !store.readingRuns(for: chapter.articleId).isEmpty
    }

    private var currentChapter: BookChapterSummary? {
        guard chapters.indices.contains(chapterIndex) else { return nil }
        return chapters[chapterIndex]
    }

    private var currentArticle: Article? {
        currentChapter.flatMap { store.chapterArticle(id: $0.articleId) }
    }

    var body: some View {
        Group {
            if let chapter = currentChapter {
                if renderMode == .original, let url = chapterFileURL(chapter) {
                    originalLayout(chapter: chapter, url: url)
                } else {
                    NativeChapterView(
                        segments: store.segments(for: chapter.articleId),
                        selectedSegmentID: $selectedSegmentID,
                        fontSize: fontSize,
                        viewMode: viewMode,
                        restoreOrder: restoreOrder,
                        onVisibleOrderChanged: { order in
                            visibleOrder = order
                            saveProgressIfNeeded()
                        },
                        markedOrders: markedOrders,
                        readingRuns: showReading
                            ? store.readingRuns(for: chapter.articleId) : [:],
                        onMark: { segment, kind in addMark(segment: segment, kind: kind) }
                    )
                }
            } else {
                ContentUnavailableView(
                    L("book.empty.title"), systemImage: "book.closed",
                    description: Text(L("book.empty.message")))
            }
        }
        .background(theme.background)
        .safeAreaInset(edge: .bottom) { bottomBar }
        .task(id: chapterIndex) { await openCurrentChapter() }
        .onAppear {
            restoreFromProgress()
            jumpToInitialLocationIfNeeded()
        }
        .onDisappear { saveProgress(force: true) }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { saveProgress(force: true) }
        }
        // 阅读计时交给共用的 ReadingClock：翻章时会自动结算上一章再给新章起表，
        // 不再像原来那样把整段阅读都记在停下来的那一章上。
        .readingClock(articleID: currentChapter?.articleId)
        // 挂在导航修饰之前：底部的翻章条留在左栏，导航栏横跨两栏。
        .explanationPane(
            article: currentArticle, selection: $selectedSegmentID, isCollapsed: paneCollapsed)
        .navigationTitle(currentChapter?.title ?? book.title)
        .navigationBarTitleDisplayMode(.inline)
        // 阅读时收起底部 tab 栏：翻页条已经占了底部，再叠一层 tab 太挤。
        // 宽屏不收——那边的主导航是侧边栏。
        .hidesAppTabBar()
        .toolbar { toolbar }
        .sheet(
            isPresented: Binding(
                get: { pendingWord != nil }, set: { if !$0 { pendingWord = nil } })
        ) {
            VocabEditSheet(
                favorite: nil, prefilledWord: pendingWord,
                sourceArticle: currentArticle, sourceSegmentID: pendingSegmentID)
        }
        .sheet(isPresented: $showBookmarks) {
            BookmarksSheet(book: book) { index, order in
                jump(chapter: index, order: order)
            }
        }
        .sheet(isPresented: $showChapters) {
            ChapterListSheet(book: book, currentIndex: chapterIndex) { index in
                goTo(chapter: index)
            }
        }
    }

    // MARK: - 书签 / 划线

    /// 本章已标记的句序。锚点可能因重新切分而漂移，所以逐条走重锚级联。
    private var markedOrders: Set<Int> {
        guard let chapter = currentChapter else { return [] }
        let segments = store.segments(for: chapter.articleId)
        guard !segments.isEmpty else { return [] }
        let marks = store.marks(ofBook: book.id, chapterIndex: chapterIndex)
        return Set(marks.compactMap { MarkAnchor.resolve($0, in: segments).segmentOrder })
    }

    private func addMark(segment: ArticleSegment, kind: BookMark.Kind) {
        guard let chapter = currentChapter else { return }
        let total = store.progress(for: chapter.articleId).total
        store.saveMark(
            BookMark(
                bookId: book.id,
                chapterArticleId: chapter.articleId,
                chapterIndex: chapterIndex,
                kind: kind,
                segmentOrder: segment.order,
                // 两种模式的锚点都填上，切模式后书签仍能定位。
                scrollFraction: total > 0 ? Double(segment.order) / Double(total) : 0,
                selectedText: segment.text))
    }

    /// 原版模式划线：定位符 + 原文都存，重锚时按可靠性依次回退。
    private func addHighlight(_ selection: OriginalLayoutView.WebSelection) {
        guard let chapter = currentChapter else { return }
        let segments = store.segments(for: chapter.articleId)
        let match = SelectionResolver.resolve(selection: selection.text, in: segments)
        store.saveMark(
            BookMark(
                bookId: book.id,
                chapterArticleId: chapter.articleId,
                chapterIndex: chapterIndex,
                kind: .highlight,
                segmentOrder: match?.order,
                charStart: match?.range?.lowerBound,
                charEnd: match?.range?.upperBound,
                locator: selection.locator,
                scrollFraction: scrollFraction,
                selectedText: selection.text))
        webSelection = nil
    }

    /// 搜索结果落点：走的还是书签那条路（切章 + restoreOrder），不写第二套定位。
    private func jumpToInitialLocationIfNeeded() {
        guard let order = initialSegmentOrder else { return }
        let index = initialChapterIndex ?? chapterIndex
        guard chapters.indices.contains(index) else { return }
        jump(chapter: index, order: order)
    }

    /// 从书签面板跳转：先切章，再滚到那一句。
    private func jump(chapter index: Int, order: Int?) {
        goTo(chapter: index)
        guard let order else { return }
        restoreOrder = order
        visibleOrder = order
    }

    // MARK: - 原版模式

    /// 当前章的原始文件是否还在——决定原版模式能不能用。
    private var canUseOriginalMode: Bool {
        currentChapter.flatMap(chapterFileURL) != nil
    }

    /// 章节原始文件在书籍目录里的位置。文件不在（换机恢复后 Books/ 没回来）时返回 nil，
    /// 原版模式随之不可用，但原生模式仍能读——正文另存在 article.content 里。
    private func chapterFileURL(_ chapter: BookChapterSummary) -> URL? {
        guard let href = store.chapterSourceHref(articleID: chapter.articleId),
            let root = store.bookDirectory(for: book.id)
        else { return nil }
        let url = root.appendingPathComponent(href)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    @ViewBuilder
    private func originalLayout(chapter: BookChapterSummary, url: URL) -> some View {
        ZStack(alignment: .topLeading) {
            OriginalLayoutView(
                chapterURL: url,
                bookDirectory: store.bookDirectory(for: book.id) ?? url,
                fontScale: fontSize / 18,
                restoreFraction: scrollFraction,
                highlights: store.marks(ofBook: book.id, chapterIndex: chapterIndex)
                    .filter { $0.kind == .highlight }
                    .map { (locator: $0.locator, text: $0.selectedText) },
                onScroll: { fraction in
                    scrollFraction = fraction
                    saveProgressIfNeeded()
                },
                onSelection: { webSelection = $0 },
                onNavigate: { target in
                    // 站内链接：换算成章节索引后走正常翻章路径。
                    guard let index = store.chapterIndex(of: book.id, fileURL: target) else {
                        return
                    }
                    goTo(chapter: index)
                }
            )
            if let selection = webSelection, let rect = selection.rects.first {
                // 容器宽度不能用 canvas：宽屏下精讲右栏会把正文栏挤窄。
                SelectionActionBar(
                    anchor: rect,
                    canExplain: !book.originalOnly,
                    onExplain: { explainSelection(selection) },
                    onFavorite: { favoriteSelection(selection) },
                    onHighlight: { addHighlight(selection) },
                    onCopy: {
                        UIPasteboard.general.string = selection.text
                        webSelection = nil
                    }
                )
                // 浮在选区上方，贴边时下移，避免顶出屏幕。
                //
                // 右边界同样要夹：原先只挡了左边和上边，在段落右侧划词时
                // 操作条会被推出可视区。窄屏勉强不显，宽屏下正文栏被精讲栏挤窄后必现。
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: {
                    selectionBarWidth = $0
                }
                .offset(
                    x: SelectionBarPlacement.x(
                        anchorMinX: rect.minX,
                        barWidth: selectionBarWidth,
                        containerWidth: readerWidth),
                    y: SelectionBarPlacement.y(anchorMinY: rect.minY, anchorMaxY: rect.maxY))
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { readerWidth = $0 }
    }

    /// 划词 → 精讲：把选区映射回本章的某一句，然后复用**未经修改**的 ExplanationSheet。
    /// 两种模式的文本出自同一个抽取器，所以这个映射几乎总能命中。
    private func explainSelection(_ selection: OriginalLayoutView.WebSelection) {
        guard let chapter = currentChapter else { return }
        let segments = store.segments(for: chapter.articleId)
        guard let match = SelectionResolver.resolve(selection: selection.text, in: segments)
        else { return }
        webSelection = nil
        selectedSegmentID = match.segmentID
    }

    /// 划词收藏：打开生词编辑表并预填词形。
    /// 不直接建卡——没有释义的 SRS 卡片复习时毫无用处。
    private func favoriteSelection(_ selection: OriginalLayoutView.WebSelection) {
        let word = selection.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !word.isEmpty else { return }
        pendingWord = word
        if let chapter = currentChapter {
            let segments = store.segments(for: chapter.articleId)
            pendingSegmentID = SelectionResolver.resolve(
                selection: selection.text, in: segments)?.segmentID
        }
        webSelection = nil
    }

    // MARK: - 章节切换

    private func openCurrentChapter() async {
        guard let chapter = currentChapter else { return }
        // 首开该章时在这里延迟切分（导入时不切句）。
        await store.openArticle(chapter.articleId)
    }

    private func goTo(chapter index: Int) {
        guard chapters.indices.contains(index) else { return }
        saveProgress(force: true)
        chapterIndex = index
        visibleOrder = 0
        restoreOrder = nil
        selectedSegmentID = nil
    }

    // MARK: - 续读位置

    /// 同步来的书（网页导入、或别的设备导入）本机没有原始文件：
    /// 默认模式 / 进度里记的是"原版"也只能用原生模式读 —— 正文在章节 article 里。
    private func fallBackToNativeIfNoFile() {
        if renderMode == .original && !book.originalOnly && !canUseOriginalMode {
            renderMode = .native
        }
    }

    private func restoreFromProgress() {
        guard let progress = store.progress(ofBook: book.id) else {
            renderMode = book.originalOnly ? .original : book.defaultMode
            fallBackToNativeIfNoFile()
            return
        }
        if chapters.indices.contains(progress.chapterIndex) {
            chapterIndex = progress.chapterIndex
        }
        renderMode = book.originalOnly ? .original : progress.mode
        fallBackToNativeIfNoFile()
        let count = currentChapter.map { store.progress(for: $0.articleId).total } ?? 0
        restoreOrder = progress.resolvedSegmentOrder(segmentCount: max(count, 1))
        visibleOrder = restoreOrder ?? 0
        scrollFraction = progress.resolvedFraction(segmentCount: max(count, 1))
    }

    /// 切模式时把位置换算过去，落点不会回到章首。
    /// 两个锚点一直同时维护，所以任一方向都有值可用。
    private func switchMode(to mode: BookRenderMode) {
        guard mode != renderMode, let chapter = currentChapter else { return }
        saveProgress(force: true)
        let total = store.progress(for: chapter.articleId).total
        switch mode {
        case .native:
            restoreOrder = total > 0 ? Int((scrollFraction * Double(total)).rounded()) : 0
            visibleOrder = restoreOrder ?? 0
        case .original:
            scrollFraction = total > 0 ? Double(visibleOrder) / Double(total) : 0
        }
        webSelection = nil
        renderMode = mode
    }

    private func saveProgressIfNeeded() {
        guard let lastSavedAt else {
            saveProgress(force: true)
            return
        }
        guard Date().timeIntervalSince(lastSavedAt) >= Self.saveInterval else { return }
        saveProgress(force: false)
    }

    private func saveProgress(force: Bool) {
        guard let chapter = currentChapter else { return }
        let total = store.progress(for: chapter.articleId).total
        // 两个锚点始终同时写：当前模式的那个是实测值，另一个按比例换算，
        // 这样任何时候切模式都有落点，不会掉回章首。
        let order: Int
        let fraction: Double
        switch renderMode {
        case .native:
            order = visibleOrder
            fraction = total > 0 ? Double(visibleOrder) / Double(total) : 0
        case .original:
            fraction = scrollFraction
            order = total > 0 ? Int((scrollFraction * Double(total)).rounded()) : 0
        }
        lastSavedAt = Date()
        store.saveBookProgress(
            BookProgress(
                bookId: book.id,
                chapterArticleId: chapter.articleId,
                chapterIndex: chapterIndex,
                segmentOrder: order,
                scrollFraction: fraction,
                mode: renderMode))
    }

    // MARK: - 底部翻章条

    @ViewBuilder
    private var bottomBar: some View {
        VStack(spacing: 0) {
            if let chapter = currentChapter {
                // 跑完之后若有可重试的失败句，这里会自动变成重试入口
                batchProgress(articleID: chapter.articleId)
            }
            HStack {
                Button {
                    goTo(chapter: chapterIndex - 1)
                } label: {
                    Label(L("book.chapter.previous"), systemImage: "chevron.left")
                        .labelStyle(.iconOnly)
                }
                .disabled(chapterIndex <= 0)

                Spacer()
                Button {
                    showChapters = true
                } label: {
                    Text(verbatim: "\(chapterIndex + 1) / \(chapters.count)")
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(theme.mutedForeground)
                }
                Spacer()

                Button {
                    goTo(chapter: chapterIndex + 1)
                } label: {
                    Label(L("book.chapter.next"), systemImage: "chevron.right")
                        .labelStyle(.iconOnly)
                }
                .disabled(chapterIndex >= chapters.count - 1)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }

    private func batchProgress(articleID: UUID) -> some View {
        BatchProgressBar(articleID: articleID)
    }

    // MARK: - 工具栏

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        // 只有宽屏才有右栏可收；窄屏走 sheet，收起是没有意义的概念。
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
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                showChapters = true
            } label: {
                Image(systemName: "list.bullet")
            }
            .accessibilityLabel(Text(L("book.toc")))
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                showBookmarks = true
            } label: {
                Image(systemName: "bookmark")
            }
            .accessibilityLabel(Text(L("bookmark.title")))
        }
        // 原版模式由 WebView 排版，原书自带的 <ruby> 本来就会渲染，无需这个开关。
        if renderMode == .native {
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
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if let chapter = currentChapter {
                    let progress = store.progress(for: chapter.articleId)
                    let running = store.isBatchRunning(articleID: chapter.articleId)
                    // 批量任务按章进行：整本书上万句，一次全精讲不是功能是事故。
                    Section(L("book.batch.chapterScope")) {
                        Button {
                            store.batchExplainAll(articleID: chapter.articleId)
                        } label: {
                            Label(L("reader.batch.explainAll"), systemImage: "sparkles")
                        }
                        .disabled(running || progress.explained >= progress.total)
                        Button {
                            store.batchTranslateAll(articleID: chapter.articleId)
                        } label: {
                            Label(
                                L("reader.batch.translateAll"),
                                systemImage: "character.book.closed")
                        }
                        .disabled(running)
                    }
                }
                Section {
                    Button {
                        switchMode(to: renderMode == .native ? .original : .native)
                    } label: {
                        Label(
                            L(renderMode == .native
                                ? "book.mode.original" : "book.mode.native"),
                            systemImage: renderMode == .native
                                ? "doc.richtext" : "text.alignleft")
                    }
                    // 固定版式书抽不出正文，原生模式无意义；
                    // 书籍文件丢了则反过来，原版模式无从加载。
                    .disabled(
                        (book.originalOnly && renderMode == .original) || !canUseOriginalMode)
                } footer: {
                    if book.originalOnly {
                        Text(L("book.mode.originalOnly.hint"))
                    } else if !canUseOriginalMode {
                        // 换机恢复后 Books/ 没随备份回来：原版模式不可用，但正文还在。
                        Text(L("book.originalFilesMissing"))
                    }
                }
                if renderMode == .native {
                    Picker(selection: $viewMode, label: Text("")) {
                        ForEach(ReaderViewMode.allCases) { mode in
                            Text(L(mode.titleKey)).tag(mode)
                        }
                    }
                    Section {
                        Toggle(isOn: $showReading) {
                            Label(L("reader.showReading"), systemImage: "character.phonetic")
                        }
                        .disabled(!hasReadings)
                    } header: {
                        if !hasReadings { Text(L("reader.reading.unavailable")) }
                    }
                }
                Section(L("reader.fontSize")) {
                    Stepper(value: $fontSize, in: 12...32, step: 2) {
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
