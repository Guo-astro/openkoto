import Foundation
import Testing

@testable import OKPersistence

/// 与 `packages/core/test/hlc.test.ts` 逐条对应：两端的 HLC 必须逐字节一致，
/// 否则服务端的 LWW（字符串比较）会在两种客户端之间给出不同的胜负。
@Suite struct HLCTests {
    @Test func formatsAndParses() throws {
        let s = HLCTimestamp(wall: 1_727_500_000_123, counter: 1, node: "a1b2c3d4").description
        #expect(s == "1727500000123-0001-a1b2c3d4")
        let parsed = try #require(HLCTimestamp(s))
        #expect(parsed == HLCTimestamp(wall: 1_727_500_000_123, counter: 1, node: "a1b2c3d4"))
        #expect(!HLCTimestamp.isValid("123-0001-a1b2c3d4"))
        #expect(HLCTimestamp("nope") == nil)
        #expect(!HLCTimestamp.isValid("1727500000123-0001-A1B2C3D4"), "node 必须是小写十六进制")
        #expect(HLCTimestamp(wall: 5, counter: 0, node: "00000000").description == "0000000000005-0000-00000000")
    }

    @Test func derivesNodeIDsFromDeviceIDs() {
        #expect(HLCTimestamp.nodeID(fromDevice: "D7F1A2B3-0000-4000-8000-000000000000") == "d7f1a2b3")
        #expect(HLCTimestamp.nodeID(fromDevice: "ab") == "ab000000")
    }

    @Test func ordersLexicographically() throws {
        #expect(compareHLC("0000000000002-0000-00000000", "0000000000010-0000-00000000") == -1)
        let date = try #require(ISO8601DateFormatter().date(from: "2026-09-28T10:00:00Z"))
        #expect(compareHLC(HLCTimestamp.legacy(date).description, HLCTimestamp.legacy(date).description) == 0)
        // Date.parse("2026-09-28T10:00:00Z") = 1790589600000
        #expect(HLCTimestamp.legacy(date).description == "1790589600000-0000-00000000")
    }

    @Test func ticksMonotonicallyWhenTheWallClockStallsOrGoesBack() throws {
        final class Box: @unchecked Sendable { var now: Int64 = 1000 }
        let box = Box()
        var clock = HybridLogicalClock(node: "aaaaaaaa", initial: nil, now: { box.now })
        let a = try #require(HLCTimestamp(clock.tick()))
        let b = try #require(HLCTimestamp(clock.tick()))
        box.now = 500
        let c = try #require(HLCTimestamp(clock.tick()))
        #expect(a.wall == 1000 && a.counter == 0)
        #expect(b.wall == 1000 && b.counter == 1)
        #expect(c.wall == 1000 && c.counter == 2)
        box.now = 2000
        let d = try #require(HLCTimestamp(clock.tick()))
        #expect(d.wall == 2000 && d.counter == 0)
    }

    @Test func mergesRemoteTimestamps() {
        var clock = HybridLogicalClock(node: "aaaaaaaa", initial: "0000000001000-0003-aaaaaaaa", now: { 1000 })
        // 两边 wall 相等 → max(counter)+1
        #expect(clock.receive("0000000001000-0007-bbbbbbbb") == "0000000001000-0008-aaaaaaaa")
        // 远端超前 → 远端 counter + 1
        #expect(clock.receive("0000000005000-0002-bbbbbbbb") == "0000000005000-0003-aaaaaaaa")
        // 本地超前 → 本地 counter + 1
        #expect(clock.receive("0000000000010-0009-bbbbbbbb") == "0000000005000-0004-aaaaaaaa")
        var later = HybridLogicalClock(node: "aaaaaaaa", initial: "0000000001000-0003-aaaaaaaa", now: { 9000 })
        #expect(later.receive("0000000002000-0005-bbbbbbbb") == "0000000009000-0000-aaaaaaaa")
    }

    @Test func rollsTheCounterOverIntoTheWall() {
        var clock = HybridLogicalClock(node: "aaaaaaaa", initial: "0000000001000-9999-aaaaaaaa", now: { 0 })
        #expect(clock.tick() == "0000000001001-0000-aaaaaaaa")
        #expect(clock.current == "0000000001001-0000-aaaaaaaa")
    }

    @Test func invalidRemoteDoesNotMoveTheClock() {
        var clock = HybridLogicalClock(node: "aaaaaaaa", initial: "0000000001000-0003-aaaaaaaa", now: { 0 })
        #expect(clock.receive("garbage") == "0000000001000-0003-aaaaaaaa")
    }
}
