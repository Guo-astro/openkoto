import Foundation
import OKModels

/// 歌词正文 → 逐行句子（兜底用）。
///
/// 正常情况下歌词的句子随同步一起到（网页导入时已按 LRC 切好、带 `startTime`）。
/// 只有正文到了、句子没到（或别的客户端只传了正文）时才在本机切：
/// 认 `[mm:ss.xx]` 时间标签（一行多个标签 = 同一句在多个时刻出现），
/// 跳过 `[ar:]` 之类的头部标签；不带时间的行保留为无时间的句子。
enum LyricsLines {
    static func segments(for article: Article) -> [ArticleSegment] {
        var lines: [(time: Double?, text: String)] = []
        var offset = 0.0
        for raw in article.content.split(whereSeparator: \.isNewline) {
            var rest = Substring(raw.trimmingCharacters(in: .whitespaces))
            var times: [Double] = []
            var isHeader = false
            while rest.hasPrefix("["), let close = rest.firstIndex(of: "]") {
                let tag = rest[rest.index(after: rest.startIndex)..<close]
                if let time = parseTime(tag) {
                    times.append(time)
                } else {
                    let parts = tag.split(separator: ":", maxSplits: 1)
                    if parts.count == 2, parts[0].lowercased() == "offset",
                        let ms = Double(parts[1].trimmingCharacters(in: .whitespaces))
                    {
                        offset = ms / 1000
                    }
                    isHeader = true
                }
                rest = rest[rest.index(after: close)...]
            }
            let text = rest.trimmingCharacters(in: .whitespaces)
            if times.isEmpty {
                if !isHeader, !text.isEmpty { lines.append((nil, text)) }
            } else if !text.isEmpty {
                lines += times.map { ($0, text) }
            }
        }
        // 带时间的按时间排（多标签行会打乱顺序）；纯文本歌词保持原序。
        if lines.contains(where: { $0.time != nil }) {
            lines = lines.enumerated().sorted {
                ($0.element.time ?? .infinity, $0.offset) < ($1.element.time ?? .infinity, $1.offset)
            }.map(\.element)
        }
        return lines.enumerated().map { index, line in
            let start = line.time.map { max($0 - offset, 0) }
            let next = lines.dropFirst(index + 1).first { $0.time != nil }?.time.map { max($0 - offset, 0) }
            return ArticleSegment(
                articleId: article.id, order: index, text: line.text,
                isNewParagraph: false, startTime: start, endTime: start == nil ? nil : next,
                createdAt: article.createdAt)
        }
    }

    /// `mm:ss`、`mm:ss.xx`、`mm:ss:xx`。
    static func parseTime(_ tag: Substring) -> Double? {
        let parts = tag.split(separator: ":")
        guard parts.count >= 2, let minutes = Double(parts[0]),
            parts[0].allSatisfy(\.isNumber)
        else { return nil }
        let secondsText = parts.count == 3 ? "\(parts[1]).\(parts[2])" : String(parts[1])
        guard let seconds = Double(secondsText) else { return nil }
        return minutes * 60 + seconds
    }
}
