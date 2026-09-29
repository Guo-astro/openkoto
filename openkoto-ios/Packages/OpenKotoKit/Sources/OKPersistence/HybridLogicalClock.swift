import Foundation

/// 混合逻辑时钟（`docs/specs/sync-protocol-spec.md` §3）。
///
/// **与 `packages/core/src/hlc.ts` 逐行对应**，改这里必须同步改那边（反之亦然）：
/// 格式 `<wallMs 13 位>-<counter 4 位>-<nodeId 8 位小写十六进制>`，按字符串字典序比较。
public struct HLCTimestamp: Sendable, Hashable, Comparable, CustomStringConvertible {
    public var wall: Int64
    public var counter: Int
    public var node: String

    public init(wall: Int64, counter: Int, node: String) {
        self.wall = wall
        self.counter = counter
        self.node = node
    }

    static let maxCounter = 9999

    /// 解析；格式不对返回 nil（TS 版抛错，Swift 这边让调用方决定怎么处理）。
    public init?(_ value: String) {
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
            parts[0].count == 13, parts[0].allSatisfy(\.isASCIIDigit),
            parts[1].count == 4, parts[1].allSatisfy(\.isASCIIDigit),
            parts[2].count == 8, parts[2].allSatisfy(\.isLowerHexDigit),
            let wall = Int64(parts[0]), let counter = Int(parts[1])
        else { return nil }
        self.init(wall: wall, counter: counter, node: String(parts[2]))
    }

    public static func isValid(_ value: String) -> Bool { HLCTimestamp(value) != nil }

    public var description: String {
        let wallText = String(wall)
        let counterText = String(counter)
        return String(repeating: "0", count: max(0, 13 - wallText.count)) + wallText + "-"
            + String(repeating: "0", count: max(0, 4 - counterText.count)) + counterText + "-"
            + node
    }

    public static func < (lhs: HLCTimestamp, rhs: HLCTimestamp) -> Bool {
        lhs.description < rhs.description
    }

    /// `deviceId` 去掉连字符后的前 8 位（不足补 0）。
    public static func nodeID(fromDevice deviceID: String) -> String {
        let hex = deviceID.replacingOccurrences(of: "-", with: "").lowercased()
        return String((hex + "00000000").prefix(8))
    }

    /// 没有 HLC 的历史数据：`<ms>-0000-<node>`（协议 §3 末条；node 缺省 `00000000`）。
    public static func legacy(_ date: Date, node: String = "00000000") -> HLCTimestamp {
        HLCTimestamp(wall: Int64((date.timeIntervalSince1970 * 1000).rounded(.down)), counter: 0, node: node)
    }

    public var date: Date { Date(timeIntervalSince1970: TimeInterval(wall) / 1000) }

    fileprivate func normalized() -> HLCTimestamp {
        counter > Self.maxCounter ? HLCTimestamp(wall: wall + 1, counter: 0, node: node) : self
    }
}

extension Character {
    fileprivate var isASCIIDigit: Bool { ("0"..."9").contains(self) }
    fileprivate var isLowerHexDigit: Bool { isASCIIDigit || ("a"..."f").contains(self) }
}

/// 字典序比较（与 TS `compareHlc` 一致）。
public func compareHLC(_ a: String, _ b: String) -> Int {
    a < b ? -1 : (a > b ? 1 : 0)
}

/// 本机时钟。值语义，由 `HTTPSyncEngine` 持有并落库（`sync_state.http_clock`）。
public struct HybridLogicalClock: Sendable {
    public let node: String
    public private(set) var last: HLCTimestamp
    private let now: @Sendable () -> Int64

    public init(
        node: String, initial: String? = nil,
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.node = node
        self.now = now
        self.last = initial.flatMap(HLCTimestamp.init) ?? HLCTimestamp(wall: 0, counter: 0, node: node)
    }

    /// 本地修改。
    public mutating func tick() -> String {
        let pt = now()
        let next =
            pt > last.wall
            ? HLCTimestamp(wall: pt, counter: 0, node: node)
            : HLCTimestamp(wall: last.wall, counter: last.counter + 1, node: node)
        last = next.normalized()
        return last.description
    }

    /// 收到远端时间戳。格式不对时原样返回当前值（不推进）。
    @discardableResult
    public mutating func receive(_ remote: String) -> String {
        guard let r = HLCTimestamp(remote) else { return current }
        let pt = now()
        let wall = max(last.wall, r.wall, pt)
        let counter: Int
        if wall == last.wall && wall == r.wall {
            counter = max(last.counter, r.counter) + 1
        } else if wall == last.wall {
            counter = last.counter + 1
        } else if wall == r.wall {
            counter = r.counter + 1
        } else {
            counter = 0
        }
        last = HLCTimestamp(wall: wall, counter: counter, node: node).normalized()
        return last.description
    }

    public var current: String { last.description }
}
