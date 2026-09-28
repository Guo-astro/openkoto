import Foundation
import OKModels
import Testing

@testable import OKSRS

/// 同步协议 §6 的重放契约用例（`docs/specs/fixtures/sync/replay-cases.json`）。
///
/// 所有客户端都必须跑同一份用例：同一组事件（乱序、重复、撤销、两台设备同日）
/// 在任何一端重放都得到同一张卡。**不要改期望值去迁就实现**。
@Suite struct ReplayContractTests {
    private static var fixtureURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // OKSRSTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // OpenKotoKit
            .deletingLastPathComponent()  // Packages
            .deletingLastPathComponent()  // openkoto-ios
            .deletingLastPathComponent()  // repo root
            .appending(path: "docs/specs/fixtures/sync/replay-cases.json")
    }

    struct Fixture: Decodable {
        struct Defaults: Decodable {
            var timeZone: String
            var desiredRetention: Double
        }

        struct Initial: Decodable {
            var stability: Double
            var difficulty: Double
            var srsState: String?
            var dueDate: String?
            var lastReviewedAt: String?
            var reviewCount: Int?
        }

        struct Event: Decodable {
            var id: String
            var hlc: String
            var payload: [String: AnyJSON]
        }

        struct Expected: Decodable {
            var srsState: String
            var stability: Double
            var difficulty: Double
            var dueDate: String
            var lastReviewedAt: String?
            var reviewCount: Int
            var schedulerVersion: String
        }

        struct Case: Decodable {
            var name: String
            var initial: Initial?
            var events: [Event]
            var expected: Expected
        }

        var defaults: Defaults
        var cases: [Case]
    }

    /// 只为把 payload 原样转回 JSON。
    enum AnyJSON: Codable {
        case string(String), number(Double), bool(Bool), null

        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if c.decodeNil() { self = .null }
            else if let b = try? c.decode(Bool.self) { self = .bool(b) }
            else if let n = try? c.decode(Double.self) { self = .number(n) }
            else { self = .string(try c.decode(String.self)) }
        }

        func encode(to encoder: Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case .string(let s): try c.encode(s)
            case .number(let n):
                if n == n.rounded() && abs(n) < 1e15 { try c.encode(Int(n)) } else { try c.encode(n) }
            case .bool(let b): try c.encode(b)
            case .null: try c.encodeNil()
            }
        }
    }

    static func iso(_ text: String) -> Date? {
        let plain = ISO8601DateFormatter()
        if let date = plain.date(from: text) { return date }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text)
    }

    static func isoMillis(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    @Test func allReplayCasesMatchTheReference() throws {
        let data = try Data(contentsOf: Self.fixtureURL)
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        #expect(fixture.cases.count >= 9)

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: fixture.defaults.timeZone))
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            guard let date = Self.iso(text) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: text))
            }
            return date
        }

        for testCase in fixture.cases {
            var hlcs: [UUID: String] = [:]
            let events = try testCase.events.map { raw -> ReviewEvent in
                var payload = raw.payload
                payload["id"] = .string(raw.id)
                let event = try decoder.decode(
                    ReviewEvent.self, from: try JSONEncoder().encode(payload))
                if hlcs[event.id] == nil { hlcs[event.id] = raw.hlc }
                return event
            }
            let initial = try testCase.initial.map { seed in
                ReviewReplay.InitialState(
                    stability: seed.stability, difficulty: seed.difficulty,
                    srsState: seed.srsState.flatMap(SRSState.init(rawValue:)),
                    dueDate: seed.dueDate,
                    lastReviewedAt: try seed.lastReviewedAt.map { try #require(Self.iso($0)) },
                    reviewCount: seed.reviewCount ?? 0)
            }

            let state = try #require(
                ReviewReplay.replay(
                    events, desiredRetention: fixture.defaults.desiredRetention,
                    calendar: calendar, initial: initial, hlcs: hlcs),
                "\(testCase.name): no state")
            let expected = testCase.expected
            #expect(state.srsState.rawValue == expected.srsState, "\(testCase.name)")
            #expect(abs(state.stability - expected.stability) < 1e-6, "\(testCase.name) stability \(state.stability)")
            #expect(abs(state.difficulty - expected.difficulty) < 1e-6, "\(testCase.name) difficulty \(state.difficulty)")
            #expect(state.dueDate == expected.dueDate, "\(testCase.name) due \(state.dueDate)")
            #expect(Self.isoMillis(state.lastReviewedAt) == expected.lastReviewedAt, "\(testCase.name)")
            #expect(state.reviewCount == expected.reviewCount, "\(testCase.name) count")
            #expect(state.schedulerVersion == expected.schedulerVersion, "\(testCase.name)")
        }
    }

    /// 撤销标记本身不算一次复习，被它作废的那条也不算；全撤销了就没有有效事件。
    @Test func fullyVoidedHistoryHasNoState() {
        let card = UUID()
        let review = ReviewEvent(
            vocabularyId: card, reviewedAt: Date(timeIntervalSince1970: 1_790_000_000),
            dateLocal: "2026-09-21", grade: 3, elapsedDays: 0, previousState: .new,
            desiredRetention: 0.9, resultStability: 0, resultDifficulty: 0, resultIntervalDays: 0,
            resultState: .review)
        let undo = ReviewEvent(
            vocabularyId: card, reviewedAt: Date(timeIntervalSince1970: 1_790_000_010),
            dateLocal: "2026-09-21", grade: 0, elapsedDays: 0, previousState: .review,
            desiredRetention: 0.9, resultStability: 0, resultDifficulty: 0, resultIntervalDays: 0,
            resultState: .new, voidsEventId: review.id)
        #expect(ReviewReplay.replay([review, undo]) == nil)
        #expect(ReviewReplay.effectiveEvents([review, undo]).isEmpty)
    }

    /// 网页撤销标记可能只带必填字段，iOS 必须照样解得开。
    @Test func minimalVoidMarkerDecodes() throws {
        let json = """
            {"id":"E1000000-0000-4000-8000-000000000003","vocabularyId":"3f0c2a4e-1d2b-4c5d-9e8f-0a1b2c3d4e5f",
             "reviewedAt":"2026-09-04T10:00:05Z","grade":0,"voidsEventId":"e1000000-0000-4000-8000-000000000002"}
            """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let event = try decoder.decode(ReviewEvent.self, from: Data(json.utf8))
        #expect(event.voidsEventId == UUID(uuidString: "e1000000-0000-4000-8000-000000000002"))
        #expect(event.dateLocal == "")
        #expect(event.desiredRetention == 0)
    }
}
