#if os(iOS)
import OKDesignSystem
import OKLocalization
import OKModels
import SwiftUI

/// 字幕列表。自动滚到当前句，但**用户一拖就停止跟随**。
///
/// 桌面端只是忘了调 `scrollIntoView`（`activeSegmentRef` 赋了值却从没用过），
/// 但光把自动滚动加上会造出一个新毛病：用户往回翻看前面的句子时被强行拽回当前句。
/// 所以必须配跟随模式，并且**不做定时自动恢复**——突然被拽走是最惹人烦的交互。
struct SubtitleListView: View {
    @Environment(\.theme) private var theme

    let segments: [ArticleSegment]
    let activeID: UUID?
    let isInGap: Bool
    let selectedID: UUID?
    let loopingID: UUID?
    let readingRuns: [UUID: [ReadingRun]]
    let fontSize: Double
    /// 原文 / 对照 / 只看译文。
    let viewMode: ReaderViewMode
    /// 盲听：文本被遮住，只留时间与循环标记。
    let isBlind: Bool
    /// 盲听中被临时揭晓的那一句。
    let revealedID: UUID?
    let onTap: (ArticleSegment) -> Void
    let onExplain: (ArticleSegment) -> Void
    let onToggleLoop: (ArticleSegment) -> Void
    /// 没有音频可循环时（歌词）把"单句循环"菜单项藏起来。
    var showsLoop = true

    @State private var isFollowing = true

    var body: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottom) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(segments) { segment in
                            SubtitleRow(
                                segment: segment,
                                isActive: segment.id == activeID,
                                isDimmed: segment.id == activeID && isInGap,
                                isSelected: segment.id == selectedID,
                                isLooping: segment.id == loopingID,
                                runs: readingRuns[segment.id],
                                fontSize: fontSize,
                                viewMode: viewMode,
                                isMasked: isBlind && segment.id != revealedID,
                                onTap: { onTap(segment) },
                                onExplain: { onExplain(segment) },
                                onToggleLoop: { onToggleLoop(segment) },
                                showsLoop: showsLoop
                            )
                            .id(segment.id)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                // 用户自己一滚就停止跟随。
                //
                // 原先用 DragGesture 判定，在 Mac（滚轮）和 iPad 触控板（两指滚）上
                // 完全不触发——用户想往回看前一句会被自动跟随强行拽回当前句。
                // 换成滚动阶段判定后三种输入都覆盖，而且比手势更准：
                // proxy.scrollTo 发起的程序化滚动是 .animating，不会误判成脱离。
                .onScrollPhaseChange { _, phase in
                    if SubtitleFollow.shouldDisengage(phase), isFollowing { isFollowing = false }
                }
                .onChange(of: activeID) { old, id in
                    guard isFollowing, let id else { return }
                    scroll(proxy: proxy, to: id, from: old)
                }

                if !isFollowing {
                    resumeButton(proxy: proxy)
                }
            }
        }
    }

    /// 滚到某一句。跨度大时不带动画——见 `SubtitleFollow.shouldAnimateScroll`。
    private func scroll(proxy: ScrollViewProxy, to id: UUID, from old: UUID?) {
        let oldIndex = old.flatMap { o in segments.firstIndex { $0.id == o } }
        let newIndex = segments.firstIndex { $0.id == id } ?? 0
        if SubtitleFollow.shouldAnimateScroll(from: oldIndex, to: newIndex) {
            withAnimation(.easeInOut(duration: 0.25)) {
                proxy.scrollTo(id, anchor: .center)
            }
        } else {
            proxy.scrollTo(id, anchor: .center)
        }
    }

    private func resumeButton(proxy: ScrollViewProxy) -> some View {
        Button {
            isFollowing = true
            // 从"用户翻到别处"回来通常就是远距离，别动画。
            if let activeID { proxy.scrollTo(activeID, anchor: .center) }
        } label: {
            Label(L("media.backToCurrent"), systemImage: "arrow.down.circle")
                .font(.footnote.weight(.medium))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(theme.card, in: Capsule())
                .overlay(Capsule().strokeBorder(theme.border, lineWidth: 1))
                .foregroundStyle(theme.primary)
                .shadow(radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .padding(.bottom, 12)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}

/// 单条字幕：时间徽章 + 句子（复用 `SentenceChip`，连带已精讲/已翻译的边框语义与注音）。
struct SubtitleRow: View {
    @Environment(\.theme) private var theme

    let segment: ArticleSegment
    let isActive: Bool
    let isDimmed: Bool
    let isSelected: Bool
    let isLooping: Bool
    let runs: [ReadingRun]?
    let fontSize: Double
    /// 原文 / 对照 / 只看译文。
    var viewMode: ReaderViewMode = .original
    /// 盲听遮罩。用 `.redacted` 而不是把文本换成占位符：
    /// 版式宽高完全不变，揭晓时不会整列跳动。
    var isMasked = false
    let onTap: () -> Void
    let onExplain: () -> Void
    let onToggleLoop: () -> Void
    var showsLoop = true

    /// 这一行主体显示什么文本。
    ///
    /// 盲听时**强制回到原文**：把译文亮出来等于把答案写在脸上，遮罩就白做了。
    /// 「只看译文」模式下没译文的句子回落到原文——不允许"正文消失"，
    /// 与 `NativeChapterView` 是同一条规矩（设计文档 §6.4）。
    private var primaryText: String {
        guard !isMasked, viewMode == .translation else { return segment.text }
        return segment.translation ?? segment.text
    }

    /// 对照模式下挂在原文底下的那行译文。盲听时不显示，理由同上。
    private var bilingualTranslation: String? {
        guard viewMode == .bilingual, !isMasked else { return nil }
        return segment.translation
    }

    /// 时间徽章宽度。译文行要按它缩进，才能和上面的句子左对齐。
    private static let timeColumnWidth: CGFloat = 46
    private static let columnSpacing: CGFloat = 10

    var body: some View {
        // 译文**必须自己占一整行**，不能塞进上面那个 HStack。
        //
        // 塞进去的话它会和末尾的 `Spacer` 抢宽度：`TranslationBox` 内部是
        // `.frame(maxWidth: .infinity)`，Spacer 也是无限可伸缩，SwiftUI 于是把剩余
        // 宽度**平分**给两者——译文只拿到半行甚至更窄，长句直接被截成「…」。
        // 对不懂外语的用户来说，看不全的译文等于没有译文。
        VStack(alignment: .leading, spacing: 4) {
            sentenceRow
            if let bilingualTranslation {
                TranslationBox(bilingualTranslation)
                    .font(.system(size: fontSize * 0.9))
                    // 保底：永远按理想高度排版，宁可把行撑高也不截断。
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, Self.timeColumnWidth + Self.columnSpacing)
            }
        }
        .padding(.vertical, 2)
        .background(
            isActive ? theme.primary.opacity(isDimmed ? 0.05 : 0.12) : .clear,
            in: RoundedRectangle(cornerRadius: OKRadius.chip))
        .contextMenu {
            Button {
                onExplain()
            } label: {
                Label(L("explanation.explanation"), systemImage: "sparkles")
            }
            if showsLoop {
                Button {
                    onToggleLoop()
                } label: {
                    Label(
                        isLooping ? L("media.loop.stop") : L("media.loop.start"),
                        systemImage: "repeat.1")
                }
            }
        }
    }

    private var sentenceRow: some View {
        HStack(alignment: .top, spacing: Self.columnSpacing) {
            Text(Self.timeText(segment.startTime))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(isActive ? theme.primary : theme.mutedForeground)
                .frame(width: Self.timeColumnWidth, alignment: .trailing)
                .padding(.top, 6)

            SentenceChip(
                text: primaryText,
                state: segment.explanation != nil
                    ? .explained : segment.translation != nil ? .translated : .plain,
                isSelected: isSelected,
                fontSize: fontSize,
                // 遮住时连注音一起遮——留着读音等于没遮。
                // 只看译文时也不给注音：注音是按原文切的词，配在译文上纯属错位。
                runs: isMasked || viewMode == .translation
                    ? nil : runs?.map { RubyRun(text: $0.text, reading: $0.reading) },
                action: onTap
            )
            .redacted(reason: isMasked ? .placeholder : [])
            // 遮住时把点击从 chip 挪到上面一层透明视图：SwiftUI 对 redacted 子树里的
            // 控件是否还响应点击并没有承诺，而"点一下揭晓"恰恰是盲听的唯一操作，
            // 不能押在这上面。
            .allowsHitTesting(!isMasked)
            .overlay {
                if isMasked {
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture(perform: onTap)
                        // 遮罩是环境值，会往下传给 overlay 的内容；这里清掉，
                        // 让这层纯粹只做"接住点击"。
                        .unredacted()
                }
            }
            .accessibilityLabel(Text(isMasked ? L("media.blind.hidden") : primaryText))
            .accessibilityAddTraits(.isButton)

            Spacer(minLength: 0)

            if isLooping {
                Image(systemName: "repeat.1")
                    .font(.caption)
                    .foregroundStyle(theme.primary)
                    .padding(.top, 6)
            }
        }
    }

    static func timeText(_ seconds: Double?) -> String {
        guard let seconds, seconds.isFinite else { return "--:--" }
        let total = Int(seconds)
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}
#endif
