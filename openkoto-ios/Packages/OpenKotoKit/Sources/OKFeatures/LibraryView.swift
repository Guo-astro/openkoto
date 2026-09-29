#if os(iOS)
import SwiftUI
import OKAIClient
import OKModels
import OKBooks
import OKDesignSystem
import OKLocalization
import PhotosUI

/// 书库列表项：单篇文章与整本书混排，按创建时间倒序。
enum LibraryItem: Identifiable, Hashable {
    case article(Article)
    case book(Book)
    case media(Media)

    var id: UUID {
        switch self {
        case .article(let article): article.id
        case .book(let book): book.id
        case .media(let media): media.id
        }
    }

    var createdAt: Date {
        switch self {
        case .article(let article): article.createdAt
        case .book(let book): book.createdAt
        case .media(let media): media.createdAt
        }
    }

    var title: String {
        switch self {
        case .article(let article): article.title
        case .book(let book): book.title
        case .media(let media): media.title
        }
    }

    var symbolName: String {
        switch self {
        case .article: "doc.text"
        case .book: "book"
        case .media: "play.rectangle"
        }
    }
}

/// 书库导航目标。
///
/// 包一层枚举而不是换成 `NavigationPath`：后者是类型擦除，会牵动三个 destination
/// 的注册、`openFirstArticleForDemoIfNeeded` 以及依赖 `-prototypeDemo` 的截图/UI 测试。
/// 这样类型安全没丢，改动面小一半。
enum LibraryRoute: Hashable {
    case item(LibraryItem)
    /// 从搜索结果跳到某篇的某一句；书籍还要带章号。
    case jump(LibraryItem, chapter: Int?, order: Int)

    var item: LibraryItem {
        switch self {
        case .item(let item): item
        case .jump(let item, _, _): item
        }
    }

    var order: Int? {
        if case .jump(_, _, let order) = self { return order }
        return nil
    }

    var chapter: Int? {
        if case .jump(_, let chapter, _) = self { return chapter }
        return nil
    }
}

/// 书库：文章/书籍卡片列表 + 导入入口（设计文档 §6.2）。
struct LibraryView: View {
    @Environment(ContentStore.self) private var store
    @Environment(\.theme) private var theme
    @Environment(\.okCanvas) private var canvas
    @State private var showImport = false
    @State private var path: [LibraryRoute] = []
    @State private var importError: String?
    @State private var isImportingBook = false
    @State private var searchQuery = ""

    private var isSearching: Bool {
        !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// 文章与书籍混排，按创建时间倒序。
    private var items: [LibraryItem] {
        let merged = store.articles.map(LibraryItem.article)
            + store.books.map(LibraryItem.book)
            + store.medias.map(LibraryItem.media)
        return merged.sorted { $0.createdAt > $1.createdAt }
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if isSearching {
                    LibrarySearchResults(
                        query: searchQuery.trimmingCharacters(in: .whitespacesAndNewlines),
                        items: items,
                        onOpen: openSearchHit)
                } else if items.isEmpty {
                    ContentUnavailableView(
                        L("library.empty.title"),
                        systemImage: "book",
                        description: Text(L("library.empty.message"))
                    )
                } else {
                    articleList
                }
            }
            .background(theme.background)
            // placement 用 .automatic：navigationBarDrawer 是 iPhone 专有的下拉抽屉布局，
            // iPad regular 宽度与 Catalyst 上要么被忽略要么错位。
            .searchable(text: $searchQuery, prompt: L("search.prompt"))
            // 从"文件"App 或其他 App 拖入 .txt/.md/.epub 文件直接导入
            .dropDestination(for: URL.self) { urls, _ in
                importDroppedFiles(urls)
            }
            .overlay {
                if isImportingBook {
                    // 解压 + 分章可能要几秒，给个明确的进行态，别让用户以为卡死。
                    ProgressView(L("import.book.parsing"))
                        .padding(24)
                        .background(theme.card, in: RoundedRectangle(cornerRadius: OKRadius.sheet))
                        .shadow(radius: 12)
                }
            }
            .alert(
                L("import.book.failed"),
                isPresented: Binding(
                    get: { importError != nil }, set: { if !$0 { importError = nil } })
            ) {
                Button(L("common.ok"), role: .cancel) {}
            } message: {
                if let importError { Text(importError) }
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showImport = true
                    } label: {
                        Label(L("library.import"), systemImage: "plus")
                    }
                }
            }
            .sheet(isPresented: $showImport) {
                ImportSheet().okSheetSizing(.form)
            }
            .navigationDestination(for: LibraryRoute.self) { route in
                switch route.item {
                case .article(let article):
                    ReaderView(article: article, initialSegmentOrder: route.order)
                case .book(let book):
                    BookReaderView(
                        book: book,
                        initialChapterIndex: route.chapter,
                        initialSegmentOrder: route.order)
                case .media(let media):
                    MediaPlayerView(media: media, initialSegmentOrder: route.order)
                }
            }
        }
        .task(id: store.pendingJump) { await consumePendingJump() }
        .onAppear { openFirstArticleForDemoIfNeeded() }
        // 数据经 GRDB 异步加载，onAppear 时可能尚未就绪，加载完成后再试一次
        .onChange(of: store.articles.first?.id) { openFirstArticleForDemoIfNeeded() }
    }

    /// 消费「回到原句」：与搜索走同一条落点逻辑，只是句序来自 segment 而非查询词。
    private func consumePendingJump() async {
        guard let jump = store.pendingJump else { return }
        // 清标志放在最后：它是 `.task(id:)` 的 id，提前清会让 SwiftUI
        // 把这条正在跑的任务取消在 await 上。用 defer 是为了连 `.unknown`
        // 那条早退路径也清掉——否则标志永远留着，同一张卡再点就没反应了。
        defer { store.pendingJump = nil }
        await store.openArticle(jump.articleID)
        let order =
            jump.segmentID
            .flatMap { id in store.segments(for: jump.articleID).first { $0.id == id } }?.order ?? 0
        switch store.container(forArticle: jump.articleID) {
        case .article(let article):
            path = [.jump(.article(article), chapter: nil, order: order)]
        case .book(let book, let chapterIndex):
            path = [.jump(.book(book), chapter: chapterIndex, order: order)]
        case .media(let media):
            path = [.jump(.media(media), chapter: nil, order: order)]
        case .unknown:
            break
        }
    }

    /// 点开一条全文命中：定位到那一句再推导航。
    ///
    /// 句序解析放在推导航**之前**——先推再滚会看到一次明显的跳动，
    /// 而定位只要小几百毫秒（懒切分），期间那条结果上有转圈。
    private func openSearchHit(_ hit: ContentStore.SearchHit) async {
        let needle = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let order = await store.locateSegmentOrder(articleID: hit.articleID, matching: needle)
        switch store.container(forArticle: hit.articleID) {
        case .article(let article):
            path = [.jump(.article(article), chapter: nil, order: order ?? 0)]
        case .book(let book, let chapterIndex):
            path = [.jump(.book(book), chapter: chapterIndex, order: order ?? 0)]
        case .media(let media):
            path = [.jump(.media(media), chapter: nil, order: order ?? 0)]
        case .unknown:
            break
        }
    }

    /// 截图/UI 测试用（-prototypeDemo）：直接打开第一篇示例文章
    private func openFirstArticleForDemoIfNeeded() {
        guard ProcessInfo.processInfo.arguments.contains("-prototypeDemo"),
              path.isEmpty, let first = store.articles.first
        else { return }
        path = [.item(.article(first))]
    }

    /// 拖入文件导入：按扩展名分流——EPUB 走书籍管线，文本够长也建书，否则单篇文章。
    @discardableResult
    private func importDroppedFiles(_ urls: [URL]) -> Bool {
        var handled = false
        for url in urls {
            handled = true
            Task { await importFile(url) }
        }
        return handled
    }

    /// 统一的文件导入入口。
    /// EPUB 必然走书籍；文本先试书籍（够长且能分章），不成再退回单篇文章。
    private func importFile(_ url: URL) async {
        isImportingBook = true
        defer { isImportingBook = false }
        do {
            if try await store.importBook(from: url) != nil { return }
        } catch {
            importError = Self.message(for: error)
            return
        }
        // 不够成书：按普通文章导入（与既有行为一致）。
        guard let parsed = try? TextImport.readTextFile(at: url),
            !parsed.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return }
        store.importArticle(title: parsed.title, content: parsed.content)
    }

    static func message(for error: Error) -> String {
        guard let failure = error as? BookImporter.Failure else {
            return error.localizedDescription
        }
        switch failure {
        case .drmProtected: return L("import.error.drm")
        case .corruptArchive: return L("import.error.corruptArchive")
        case .emptyContent: return L("import.error.emptyContent")
        case .unsupportedFormat: return L("import.error.unsupportedFormat")
        }
    }

    private var articleList: some View {
        ScrollView {
            // 宽屏自适应铺列：单列时每张卡横跨全屏，卡里只有标题+日期+句数徽章，
            // 右边一大片空白。窄屏仍是单列，与今天一致。
            LazyVGrid(columns: canvas.libraryColumns, spacing: 10) {
                ForEach(items) { item in
                    NavigationLink(value: LibraryRoute.item(item)) {
                        switch item {
                        case .article(let article): ArticleCard(article: article)
                        case .book(let book): BookCard(book: book)
                        case .media(let media): MediaCard(media: media)
                        }
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button(role: .destructive) {
                            switch item {
                            case .article(let article): store.deleteArticle(article.id)
                            case .book(let book): store.deleteBook(book.id)
                            case .media(let media): store.deleteMedia(media.id)
                            }
                        } label: {
                            Label(L("common.delete"), systemImage: "trash")
                        }
                    }
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
    }
}

private struct ArticleCard: View {
    @Environment(ContentStore.self) private var store
    @Environment(\.theme) private var theme

    let article: Article

    var body: some View {
        let progress = store.progress(for: article.id)
        ThemedCard {
            VStack(alignment: .leading, spacing: 6) {
                if article.sourceType == .lyrics {
                    Label {
                        Text(article.title)
                    } icon: {
                        Image(systemName: "music.note")
                            .foregroundStyle(theme.primary)
                    }
                    .font(.headline)
                    .foregroundStyle(theme.cardForeground)
                    .lineLimit(2)
                    if let artist = store.lyricsMeta[article.id]?.artist, !artist.isEmpty {
                        Text(verbatim: artist)
                            .font(.subheadline)
                            .foregroundStyle(theme.mutedForeground)
                            .lineLimit(1)
                    }
                } else {
                    Text(article.title)
                        .font(.headline)
                        .foregroundStyle(theme.cardForeground)
                        .lineLimit(2)
                }
                HStack(spacing: 12) {
                    Text(article.createdAt, style: .date)
                    Label("\(progress.total)", systemImage: "text.alignleft")
                    Spacer()
                    if progress.total > 0 {
                        explainedBadge(progress)
                    }
                }
                .font(.caption)
                .foregroundStyle(theme.mutedForeground)
            }
        }
    }

    @ViewBuilder
    private func explainedBadge(_ progress: (explained: Int, total: Int)) -> some View {
        if progress.explained > 0 {
            Text("\(progress.explained)/\(progress.total)")
                .font(.caption.monospacedDigit())
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(
                    theme.explained.opacity(0.12),
                    in: Capsule()
                )
                .foregroundStyle(theme.explained)
        }
    }
}

/// 导入 sheet：粘贴文本 / 本地文件（.txt/.md）/ 网页抓取（设计文档 §6.3）。
/// 文件与网址导入解析后填入同一编辑区，用户可复核再保存。
private struct ImportSheet: View {
    @Environment(ContentStore.self) private var store
    @Environment(AppConfigStore.self) private var appConfig
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme

    private enum Mode: String, CaseIterable, Identifiable {
        case paste, file, url, media
        var id: String { rawValue }
        var titleKey: String.LocalizationValue {
            switch self {
            case .paste: "import.method.paste"
            case .file: "import.method.file"
            case .url: "import.method.url"
            case .media: "import.method.media"
            }
        }
        var descKey: String.LocalizationValue {
            switch self {
            case .paste: "import.type.paste.desc"
            case .file: "import.type.file.desc"
            case .url: "import.type.url.desc"
            case .media: "import.type.media.desc"
            }
        }
        var icon: String {
            switch self {
            case .paste: "doc.on.clipboard"
            case .file: "doc.badge.plus"
            case .url: "link"
            case .media: "play.rectangle"
            }
        }
    }

    /// 要选哪一类文件。
    ///
    /// **三个 `.fileImporter` 不能叠在同一个 view 上。** SwiftUI 一个 view 只认一个
    /// presentation，叠三个的话哪个生效是未定义的 —— 实测 Mac Catalyst 上
    /// 「选择书籍」那个完全打不开面板，而 `isPresented` 已经被置成 true 且再没人复位，
    /// 于是按钮**从此彻底点不动**（用户看到的就是"点了没反应，然后怎么点都没反应"）。
    /// 收敛成一个 importer、用这个枚举选类型。
    private enum FilePicker: Identifiable {
        case book
        case subtitle
        case media

        var id: Self { self }

        var contentTypes: [UTType] {
            switch self {
            case .book: TextImport.readableContentTypes + TextImport.bookContentTypes
            case .subtitle: TextImport.subtitleContentTypes
            case .media: TextImport.mediaContentTypes
            }
        }
    }

    @State private var mode: Mode = .paste
    /// 向导步骤：1 选类型 → 2 填内容 → 3 确认并完成。
    /// 一页塞四个模式的输入区太挤了，用户不知道该先碰哪个。
    @State private var step = 1
    @State private var title = ""
    @State private var content = ""
    @State private var urlText = ""
    @State private var activePicker: FilePicker?
    /// 完成回调里读的是**这个**，不是 `activePicker`。
    ///
    /// 关闭面板与调用完成回调的先后顺序 SwiftUI 没有承诺，实测是**先**把
    /// `isPresented` 置回 false（binding 的 setter 随即清空 `activePicker`），
    /// **再**调完成回调 —— 回调去读 `activePicker` 只能拿到 nil，`switch` 落到
    /// `case nil`，选中的文件被整个丢掉。0.4.1 里书籍/字幕/视频三个入口都因此失灵：
    /// 面板能开、文件能选，选完那一行还是「可选」，「保存」一直是灰的
    /// （用户看到的就是"导不进去"）。
    /// 这份记录只在下一次点按钮时被覆盖，两种顺序下都成立。
    @State private var pendingPicker: FilePicker?
    @State private var isFetching = false
    @State private var errorMessage: String?
    /// AI 清洗态。`rawSnapshot` 是清洗前的原文——清洗失败或用户要看原文时回滚用，
    /// 没有它的话「清洗把正文删没了」就是不可逆的。
    @State private var isCleaning = false
    @State private var cleanProgress: (done: Int, total: Int)?
    @State private var cleanResult: WebContentCleaner.Result?
    @State private var rawSnapshot: (title: String, content: String)?
    @State private var showingRaw = false
    /// 视频/音频模式：字幕必选，媒体文件可选（只导字幕就是纯文稿，当文章读）。
    @State private var subtitleURL: URL?
    @State private var mediaURL: URL?
    /// 相册选中的视频。相册资源不能长期引用，取出来即拷贝，落地时走 copying 分支。
    @State private var photoItem: PhotosPickerItem?
    @State private var photoURL: URL?
    @State private var isLoadingPhoto = false
    /// 视频下载导引（YouTube/B 站链接没法在 App 里直接下，见 `MediaDownloadGuideSheet`）。
    @State private var showingDownloadGuide = false

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case 1: typeStep
                case 2: contentStep
                default: confirmStep
                }
            }
            .navigationTitle(L(stepTitleKey))
            .navigationBarTitleDisplayMode(.inline)
            // **只能有一个。** 见 `FilePicker` 的注释：叠多个的话在 Catalyst 上
            // 会有 importer 永远打不开，而且按钮会卡死在 isPresented == true。
            .fileImporter(
                isPresented: Binding(
                    get: { activePicker != nil },
                    // 用户取消时 SwiftUI 只把 isPresented 置 false，不走 completion，
                    // 这里必须跟着清空 —— 不清就是下次点同一个按钮没反应。
                    set: { if !$0 { activePicker = nil } }),
                // 用 pendingPicker：关闭时 activePicker 已被清空，拿它取类型会退化成书籍。
                allowedContentTypes: pendingPicker?.contentTypes ?? FilePicker.book.contentTypes
            ) { result in
                let picker = pendingPicker
                activePicker = nil
                pendingPicker = nil
                switch picker {
                case .book:
                    handleFileImport(result)
                case .subtitle:
                    switch result {
                    case .success(let url): subtitleURL = url
                    case .failure(let error): reportPickerFailure(error)
                    }
                case .media:
                    switch result {
                    case .success(let url):
                        mediaURL = url
                        photoURL = nil
                    case .failure(let error):
                        reportPickerFailure(error)
                    }
                case nil:
                    break
                }
            }
            .onChange(of: photoItem) { _, item in
                guard let item else { return }
                loadPhotoVideo(item)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if step == 1 {
                        Button(L("common.cancel")) { dismiss() }
                    } else {
                        Button(L("common.back")) { step -= 1 }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if step == 3 {
                        Button(L("common.done")) { save() }
                            .disabled(!canSave)
                    } else if step == 2 {
                        Button(L("common.next")) { step = 3 }
                            .disabled(!canSave)
                    }
                }
            }
            // 标题保持中性：这个 alert 现在也承载选文件失败与 AI 清洗失败，
            // 再挂「无法抓取该网页」会答非所问。
            .alert(
                L("import.failed"),
                isPresented: Binding(
                    get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })
            ) {
                Button(L("common.ok"), role: .cancel) {}
            } message: {
                if let errorMessage { Text(errorMessage) }
            }
            // 一个 view 只挂一个 presentation 的教训同样适用于 sheet——
            // 这里目前只有这一个，加新弹窗时收敛进同一个。
            .sheet(isPresented: $showingDownloadGuide) {
                MediaDownloadGuideSheet()
            }
        }
    }

    private var stepTitleKey: String.LocalizationValue {
        switch step {
        case 1: "import.step.type.title"
        case 2: "import.step.content.title"
        default: "import.step.confirm.title"
        }
    }

    // MARK: - 第一步：选类型

    private var typeStep: some View {
        List {
            ForEach(Mode.allCases) { mode in
                Button {
                    self.mode = mode
                    step = 2
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(L(mode.titleKey))
                            Text(L(mode.descKey))
                                .font(.footnote)
                                .foregroundStyle(theme.mutedForeground)
                        }
                    } icon: {
                        Image(systemName: mode.icon)
                            .foregroundStyle(theme.accent)
                    }
                    .padding(.vertical, 4)
                }
            }
        }
    }

    // MARK: - 第二步：填内容

    private var contentStep: some View {
        Form {
            switch mode {
            case .file: fileSection
            case .url: urlSection
            case .paste: editorSection
            case .media: mediaSection
            }
        }
    }

    // MARK: - 第三步：确认并完成

    /// 网页抓取/文件解析/清洗之后都可能改标题——确认页留一个可编辑的标题，
    /// 加上内容预览，让用户知道即将入库的是什么。
    private var confirmStep: some View {
        Form {
            Section {
                TextField(L("import.field.title"), text: $title)
            }
            Section {
                if mode == .media {
                    LabeledContent(
                        L("import.media.subtitle"),
                        value: subtitleURL?.lastPathComponent ?? L("import.media.optional"))
                    LabeledContent(
                        L("import.media.file"),
                        value: pickedMediaName ?? L("import.media.optional"))
                } else {
                    Text(String(format: L("import.confirm.charCount"), content.count))
                        .font(.footnote)
                        .foregroundStyle(theme.mutedForeground)
                    Text(String(content.prefix(160)))
                        .font(.footnote)
                        .foregroundStyle(theme.mutedForeground)
                        .lineLimit(4)
                    cleanRows
                }
            }
        }
    }

    private var fileSection: some View {
        Button {
            present(.book)
        } label: {
            Label(L("import.file.bookButton"), systemImage: "doc.badge.plus")
        }
    }

    /// 先记下「这次要选哪类文件」，再开面板 —— 顺序不能反，
    /// 完成回调只认 `pendingPicker`。
    private func present(_ picker: FilePicker) {
        pendingPicker = picker
        activePicker = picker
    }

    /// 取消不是错误（走完成回调时是 `.failure(userCancelled)`）；
    /// 其余失败必须说出来，否则用户只看到"选了没反应"。
    private func reportPickerFailure(_ error: Error) {
        if (error as? CocoaError)?.code == .userCancelled { return }
        errorMessage = error.localizedDescription
    }

    private var urlSection: some View {
        HStack {
            TextField(L("import.url.placeholder"), text: $urlText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
            if isFetching {
                ProgressView()
            } else {
                Button(L("import.url.fetch")) { fetchURL() }
                    .disabled(urlText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private var editorSection: some View {
        Section {
            TextField(L("import.field.title"), text: $title)
            TextEditor(text: $content)
                .frame(minHeight: 200)
                .overlay(alignment: .topLeading) {
                    if content.isEmpty {
                        Text(L("import.field.content"))
                            .foregroundStyle(theme.mutedForeground)
                            .padding(.top, 8)
                            .allowsHitTesting(false)
                    }
                }
            cleanRows
        }
    }

    // MARK: - AI 清洗

    /// 抓回来的网页/粘贴进来的正文常常混着导航、推荐位、评论、页脚。
    /// 这一条只做减法：模型判定哪些**行**是噪音，留下的每一行都还是原文那一行。
    @ViewBuilder
    private var cleanRows: some View {
        if isCleaning {
            HStack(spacing: 8) {
                ProgressView()
                Text(cleanProgressText)
                    .font(.footnote)
                    .foregroundStyle(theme.mutedForeground)
            }
        } else {
            Button {
                cleanWithAI()
            } label: {
                // Form 行里的 Button 光靠 `.disabled` 不会变灰（实测标签仍是纯黑），
                // 于是"没配模型/正文太短"时看起来还是个能点的按钮，点了却毫无反应。
                Label(
                    L(cleanResult == nil ? "import.clean.button" : "import.clean.retry"),
                    systemImage: "sparkles"
                )
                .foregroundStyle(canClean ? theme.foreground : theme.mutedForeground)
            }
            .disabled(!canClean)

            if !appConfig.hasUsableModel {
                Text(L("import.clean.noModel"))
                    .font(.footnote)
                    .foregroundStyle(theme.mutedForeground)
            }
        }

        if let cleanResult, !isCleaning {
            VStack(alignment: .leading, spacing: 6) {
                Text(
                    cleanResult.removedLines > 0
                        ? String(
                            format: L("import.clean.summary"),
                            cleanResult.removedLines, cleanResult.removedChars)
                        : L("import.clean.nothingRemoved")
                )
                .font(.footnote)
                if cleanResult.partial {
                    Text(L("import.clean.partial"))
                        .font(.footnote)
                        .foregroundStyle(theme.destructive)
                }
                if cleanResult.removedLines > 0 {
                    Button(L(showingRaw ? "import.clean.showCleaned" : "import.clean.showRaw")) {
                        toggleRaw()
                    }
                    .font(.footnote)
                }
            }
        }
    }

    /// 没配模型、正文为空、或正在忙时不给点——点了也只会失败。
    private var canClean: Bool {
        appConfig.hasUsableModel && !isFetching && !isCleaning
            && content.trimmingCharacters(in: .whitespacesAndNewlines).count
                >= WebContentCleaner.minResultChars
    }

    private var cleanProgressText: String {
        guard let cleanProgress, cleanProgress.total > 1 else { return L("import.clean.running") }
        return String(
            format: L("import.clean.progress"), cleanProgress.done, cleanProgress.total)
    }

    private func cleanWithAI() {
        // 每次清洗都从原文重来：在已清洗结果上再清一次会越删越少，
        // 而用户点「重新清洗」的本意是"换个结果"，不是"再删一轮"。
        let source = rawSnapshot ?? (title: title, content: content)
        rawSnapshot = source
        isCleaning = true
        showingRaw = false
        cleanResult = nil
        cleanProgress = nil
        errorMessage = nil

        Task {
            defer {
                isCleaning = false
                cleanProgress = nil
            }
            do {
                let result = try await appConfig.cleanImportedContent(
                    title: source.title.isEmpty ? nil : source.title,
                    content: source.content,
                    onProgress: { done, total in
                        Task { @MainActor in cleanProgress = (done, total) }
                    })
                title = result.title ?? source.title
                content = result.content
                cleanResult = result
            } catch {
                // 清洗失败不能把正文弄丢——原样退回抓取/粘贴的结果。
                title = source.title
                content = source.content
                errorMessage = ImportSheet.cleanFailureMessage(for: error)
            }
        }
    }

    private func toggleRaw() {
        guard let cleanResult, let rawSnapshot else { return }
        if showingRaw {
            title = cleanResult.title ?? rawSnapshot.title
            content = cleanResult.content
        } else {
            title = rawSnapshot.title
            content = rawSnapshot.content
        }
        showingRaw.toggle()
    }

    /// 失败原因要说清楚：「没配模型」「模型把正文删没了」「网络/额度」三种的下一步动作完全不同。
    static func cleanFailureMessage(for error: Error) -> String {
        switch error {
        case let aiError as AIClientError:
            return userMessage(for: aiError)
        case let failure as AIRequestFailure:
            return userMessage(for: failure.error)
        case WebContentCleaner.CleanError.noContent:
            return L("import.clean.failed.noContent")
        case WebContentCleaner.CleanError.tooShort:
            return L("import.clean.failed.tooShort")
        case WebContentCleaner.CleanError.allBatchesFailed(let underlying):
            if let underlying { return userMessage(for: underlying) }
            return L("import.clean.failed.generic")
        default:
            return LibraryView.message(for: error)
        }
    }

    /// EPUB 与长文本直接建书（不进编辑区——几十万字没法复核）；
    /// 短文本仍填入编辑区，保持原有"导入前可改标题正文"的体验。
    private func handleFileImport(_ result: Result<URL, Error>) {
        switch result {
        case .success(let url):
            Task {
                do {
                    if try await store.importBook(from: url) != nil {
                        dismiss()
                        return
                    }
                } catch {
                    errorMessage = LibraryView.message(for: error)
                    return
                }
                do {
                    let parsed = try TextImport.readTextFile(at: url)
                    resetCleanState()
                    title = parsed.title
                    content = parsed.content
                    step = 3
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        case .failure(let error):
            errorMessage = error.localizedDescription
        }
    }

    private func fetchURL() {
        isFetching = true
        errorMessage = nil
        resetCleanState()
        Task {
            defer { isFetching = false }
            do {
                let result = try await TextImport.fetchArticle(from: urlText)
                title = result.title
                content = result.content
                step = 3
            } catch {
                errorMessage = String(describing: error)
            }
        }
    }

    /// 换了一份正文，上一次的清洗结果与原文快照都作废——
    /// 留着的话「查看原文」会把用户换掉的那篇文章又贴回来。
    private func resetCleanState() {
        cleanResult = nil
        rawSnapshot = nil
        showingRaw = false
    }

    /// 字幕必选，媒体文件可选：只导字幕也成立——那就是一篇带时间轴的文稿。
    private var mediaSection: some View {
        Section {
            Button {
                present(.subtitle)
            } label: {
                LabeledContent {
                    Text(subtitleURL?.lastPathComponent ?? L(canTranscribeOnDevice ? "import.media.optional" : "import.media.required"))
                        .foregroundStyle(
                            subtitleURL == nil ? theme.mutedForeground : theme.foreground)
                        .lineLimit(1)
                } label: {
                    Label(L("import.media.subtitle"), systemImage: "captions.bubble")
                }
            }
            Button {
                present(.media)
            } label: {
                LabeledContent {
                    // 选中后要看得出来变了：沿用字幕那一行的深浅对比，
                    // 一直用 mutedForeground 的话「选没选上」全靠猜。
                    Text(pickedMediaName ?? L("import.media.optional"))
                        .foregroundStyle(
                            pickedMedia == nil ? theme.mutedForeground : theme.foreground)
                        .lineLimit(1)
                } label: {
                    Label(L("import.media.file"), systemImage: "film")
                }
            }
            PhotosPicker(selection: $photoItem, matching: .videos) {
                LabeledContent {
                    if isLoadingPhoto { ProgressView() }
                } label: {
                    Label(L("import.media.photoLibrary"), systemImage: "photo.on.rectangle")
                }
            }
            // 视频从哪来是导入页最高频的疑问——链接没法直接下（审核不允许），
            // 与其让用户猜，不如给一份"自己拿到文件再导进来"的导引。
            Button {
                showingDownloadGuide = true
            } label: {
                Label(L("import.media.guide.button"), systemImage: "questionmark.circle")
            }
            // 旧系统上「只选媒体」确实存不了（转写要 iOS 26）。但光把按钮灰掉
            // 等于不解释，用户只会以为导入坏了 —— 明说缺什么。
            if pickedMedia != nil, subtitleURL == nil, !canTranscribeOnDevice {
                Label(L("import.media.needSubtitle"), systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(theme.destructive)
            }
        } footer: {
            Text(L(canTranscribeOnDevice ? "import.media.footer.asr" : "import.media.footer"))
        }
    }

    /// iOS 26 能端上转写，所以「只选媒体、稍后生成字幕」也成立；
    /// 旧系统上转不了，必须有现成字幕才有意义。
    private var canTranscribeOnDevice: Bool {
        if #available(iOS 26, *) { true } else { false }
    }

    /// 相册取出的文件优先——两个来源只认最后选的那个。
    private var pickedMedia: URL? { photoURL ?? mediaURL }
    private var pickedMediaName: String? { pickedMedia?.lastPathComponent }

    private var canSave: Bool {
        mode == .media
            ? (subtitleURL != nil || (canTranscribeOnDevice && pickedMedia != nil))
            : !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func save() {
        if mode == .media {
            saveMedia()
            return
        }
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalTitle = title.isEmpty
            ? String(trimmed.prefix(while: { !$0.isNewline }).prefix(40))
            : title
        store.importArticle(title: finalTitle, content: trimmed)
        dismiss()
    }

    private func loadPhotoVideo(_ item: PhotosPickerItem) {
        isLoadingPhoto = true
        Task {
            defer { isLoadingPhoto = false }
            do {
                let video = try await item.loadTransferable(type: PhotoLibraryVideo.self)
                // nil 不抛错：不报的话用户看到的是转圈停了、什么都没变、保存还是灰的。
                guard let video else {
                    errorMessage = L("import.media.photoFailed")
                    return
                }
                photoURL = video.url
                mediaURL = nil
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func saveMedia() {
        let name = title.isEmpty ? nil : title
        // 相册那份是我们自己的临时副本，必须拷进 App 目录；
        // 「文件」那份是 security-scoped URL，存 bookmark 零拷贝即可。
        let copying = photoURL != nil
        let media = pickedMedia
        Task {
            do {
                if let subtitleURL {
                    try await store.importMedia(
                        mediaURL: media, subtitleURL: subtitleURL, title: name,
                        copyingMedia: copying)
                } else if let media {
                    // 没字幕：先建占位，进播放页再用端上转写生成
                    try await store.importMediaForTranscription(
                        mediaURL: media, title: name, copyingMedia: copying)
                } else {
                    return
                }
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
#endif
