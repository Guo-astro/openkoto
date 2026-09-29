import Foundation
import OKModels

/// 从复习事件重放出卡片的 FSRS 状态。
///
/// **这是跨设备同步唯一正确的冲突解决方式，卡片状态绝不做 last-writer-wins。**
///
/// 设想：A、B 两台设备都离线，各把同一张卡复习了一轮。联网后两条 `ReviewEvent`
/// 都会同步过来（事件表只增不删，天然无冲突），但卡片快照只有一份。
/// 若按 `updated_at` 后写胜，晚同步的那台会**整轮覆盖**掉另一台——
/// 用户明明复习了两次，进度只记了一次，而且没有任何提示。
///
/// 重放的做法是：把这张卡的全部事件按时间排好，从"新卡"状态一路算下来。
/// 两轮复习都会被计入，结果与"在同一台设备上依次复习两次"完全一致。
///
/// 与 `ContentStore` 里的实时复习共用 `FSRS.nextReview` 与 `FSRS.dueDate`，
/// 保证"重放出来的状态"和"当时算出来的状态"是同一套规则。
public enum ReviewReplay {
    public struct CardState: Sendable, Equatable {
        public var srsState: SRSState
        public var stability: Double
        public var difficulty: Double
        public var lastReviewedAt: Date
        public var dueDate: String
        public var reviewCount: Int
        public var schedulerVersion: String
    }

    /// 重放的起点：新卡（nil），或 SM-2 迁移种子。
    public struct InitialState: Sendable, Equatable {
        public var stability: Double
        public var difficulty: Double
        public var srsState: SRSState?
        public var dueDate: String?
        public var lastReviewedAt: Date?
        public var reviewCount: Int

        public init(
            stability: Double, difficulty: Double, srsState: SRSState? = nil,
            dueDate: String? = nil, lastReviewedAt: Date? = nil, reviewCount: Int = 0
        ) {
            self.stability = stability
            self.difficulty = difficulty
            self.srsState = srsState
            self.dueDate = dueDate
            self.lastReviewedAt = lastReviewedAt
            self.reviewCount = reviewCount
        }
    }

    /// 参与计算的事件：去重（id 小写）、去掉撤销标记与被作废的、去掉非法评分
    /// （与 `packages/core` 的 `effectiveReviewEvents` 同规则）。
    public static func effectiveEvents(_ events: [ReviewEvent]) -> [ReviewEvent] {
        ReviewEvent.effective(events)
    }

    /// 确定性排序：`(reviewedAt, hlc, id 小写)`（同步协议 §6）。缺 HLC 的按空串排。
    public static func ordered(_ events: [ReviewEvent], hlcs: [UUID: String] = [:])
        -> [ReviewEvent]
    {
        events.sorted { lhs, rhs in
            if lhs.reviewedAt != rhs.reviewedAt { return lhs.reviewedAt < rhs.reviewedAt }
            let lh = hlcs[lhs.id] ?? ""
            let rh = hlcs[rhs.id] ?? ""
            if lh != rh { return lh < rh }
            return lhs.id.uuidString.lowercased() < rhs.id.uuidString.lowercased()
        }
    }

    /// 重放一张卡的全部事件（同步协议 §6，与 `packages/core` 的 `replayCard` 逐步对应）。
    ///
    /// - 每条事件用**它自己记录的** `dateLocal` 与 `desiredRetention`；
    ///   缺了（旧事件）才退回 `calendar` 与参数里的 `desiredRetention`。
    ///   这样任何设备、任何时区重放出来的结果都完全一致。
    /// - 间隔天数按相邻两条的 `dateLocal` 重算，**不用事件里记的 `elapsedDays`**：
    ///   那是当时那台设备按它自己看到的历史算的，重放时前面的事件可能不一样。
    ///
    /// - Returns: 没有有效事件时返回 nil（卡片保持原状，由调用方决定怎么处理）。
    public static func replay(
        _ events: [ReviewEvent],
        desiredRetention: Double = FSRS.defaultDesiredRetention,
        calendar: Calendar = .current,
        initial: InitialState? = nil,
        hlcs: [UUID: String] = [:]
    ) -> CardState? {
        let ordered = ordered(effectiveEvents(events), hlcs: hlcs)
        guard !ordered.isEmpty else { return nil }

        var stability = initial?.stability ?? 0
        var difficulty = initial?.difficulty ?? 0
        var state =
            initial?.srsState ?? (stability == 0 && difficulty == 0 ? SRSState.new : .review)
        var dueDate = initial?.dueDate ?? ""
        var lastReviewedAt = initial?.lastReviewedAt
        var reviewCount = initial?.reviewCount ?? 0
        var lastDateLocal: String?

        for event in ordered {
            guard let grade = FSRS.Grade(rawValue: event.grade) else { continue }
            let dateLocal =
                isValidLocalDate(event.dateLocal)
                ? event.dateLocal : FSRS.localDateString(event.reviewedAt, calendar: calendar)
            let retention =
                event.desiredRetention > 0 && event.desiredRetention <= 1
                ? event.desiredRetention : desiredRetention
            let elapsed = elapsedDays(
                stability: stability, difficulty: difficulty,
                lastDateLocal: lastDateLocal, lastReviewedAt: lastReviewedAt,
                dateLocal: dateLocal, calendar: calendar)
            guard
                let update = try? FSRS.nextReview(
                    stability: stability, difficulty: difficulty,
                    elapsedDays: elapsed, grade: grade,
                    desiredRetention: retention)
            else { continue }
            stability = update.stability
            difficulty = update.difficulty
            state = update.state
            dueDate =
                grade.rawValue >= FSRS.Grade.good.rawValue
                ? addDays(dateLocal, update.intervalDays) ?? dateLocal : dateLocal
            lastReviewedAt = event.reviewedAt
            lastDateLocal = dateLocal
            reviewCount += 1
        }

        guard let lastReviewedAt, lastDateLocal != nil else { return nil }
        return CardState(
            srsState: state,
            stability: stability,
            difficulty: difficulty,
            lastReviewedAt: lastReviewedAt,
            dueDate: dueDate,
            reviewCount: reviewCount,
            schedulerVersion: FSRS.schedulerVersion)
    }

    /// 距上次复习的自然日数（SRS 规范 §2.7 / `elapsedDaysForReview`）。新卡为 0。
    static func elapsedDays(
        stability: Double, difficulty: Double, lastDateLocal: String?, lastReviewedAt: Date?,
        dateLocal: String, calendar: Calendar
    ) -> Int {
        if stability == 0 && difficulty == 0 { return 0 }
        if let lastDateLocal, let days = diffDays(lastDateLocal, dateLocal) {
            return max(days, 0)
        }
        if let lastReviewedAt,
            let days = diffDays(FSRS.localDateString(lastReviewedAt, calendar: calendar), dateLocal)
        {
            return max(days, 0)
        }
        return 0
    }

    // MARK: - "YYYY-MM-DD" 日历运算（纯日期，与时区无关）

    private static let utcCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    static func parseLocalDate(_ value: String) -> Date? {
        let parts = value.split(separator: "-")
        guard value.count == 10, parts.count == 3,
            let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
            parts[0].count == 4, parts[1].count == 2, parts[2].count == 2
        else { return nil }
        let components = DateComponents(year: year, month: month, day: day)
        guard let date = utcCalendar.date(from: components) else { return nil }
        // 2026-02-30 这类会被 Calendar 顺延，顺延了就是非法日期。
        let check = utcCalendar.dateComponents([.year, .month, .day], from: date)
        guard check.year == year, check.month == month, check.day == day else { return nil }
        return date
    }

    static func isValidLocalDate(_ value: String) -> Bool { parseLocalDate(value) != nil }

    static func diffDays(_ from: String, _ to: String) -> Int? {
        guard let a = parseLocalDate(from), let b = parseLocalDate(to) else { return nil }
        return Int((b.timeIntervalSince(a) / 86_400).rounded())
    }

    static func addDays(_ dateLocal: String, _ days: Int) -> String? {
        guard let date = parseLocalDate(dateLocal),
            let next = utcCalendar.date(byAdding: .day, value: days, to: date)
        else { return nil }
        return FSRS.localDateString(next, calendar: utcCalendar)
    }

    /// 两次复习之间跨了几个自然日。与 `ContentStore.elapsedDays` 同规则。
    static func elapsedDays(from: Date?, to: Date, calendar: Calendar) -> Int {
        guard let from else { return 0 }
        let start = calendar.startOfDay(for: from)
        let end = calendar.startOfDay(for: to)
        return max(calendar.dateComponents([.day], from: start, to: end).day ?? 0, 0)
    }
}

extension FSRS {
    /// 本地日期串 "YYYY-MM-DD"（天粒度，与桌面端语义一致）。
    public static func localDateString(_ date: Date, calendar: Calendar = .current) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// 下次到期日。**同日巩固步骤（规范 §2.8）**：
    /// 没答对（again/hard）的卡**留在今天**，当天还会回到队列里，
    /// 直到点"认识"才排到未来。FSRS 的最小间隔是 1 天，照搬就等于
    /// "一答错当天再也见不到"。
    ///
    /// 实时复习与事件重放共用这一处，否则同一张卡会因为路径不同而算出不同的到期日。
    public static func dueDate(
        grade: Grade, intervalDays: Int, reviewedAt: Date, calendar: Calendar = .current
    ) -> String {
        guard grade.rawValue >= Grade.good.rawValue else {
            return localDateString(reviewedAt, calendar: calendar)
        }
        let next =
            calendar.date(byAdding: .day, value: intervalDays, to: reviewedAt) ?? reviewedAt
        return localDateString(next, calendar: calendar)
    }
}
