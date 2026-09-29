import CryptoKit
import Foundation

/// App Store 商品（与 App Store Connect、`OpenKoto.storekit`、服务端 `billing/catalog.ts` 一致）。
public enum CommerceProduct: String, CaseIterable, Sendable {
    case plusMonthly = "com.openkoto.plus.month"
    case plusYearly = "com.openkoto.plus.year"
    case proMonthly = "com.openkoto.pro.month"
    case proYearly = "com.openkoto.pro.year"
    /// 3000 AI 积分，消耗型。
    case credits3000 = "com.openkoto.credits.3000"

    public var isSubscription: Bool { self != .credits3000 }

    public enum Tier: String, Sendable { case plus, pro, credits }

    public var tier: Tier {
        switch self {
        case .plusMonthly, .plusYearly: return .plus
        case .proMonthly, .proYearly: return .pro
        case .credits3000: return .credits
        }
    }

    public static var allIDs: [String] { allCases.map(\.rawValue) }
}

public enum AppAccountToken {
    /// `appAccountToken` 必须是 UUID。用户 id 本身是 UUID 就直接用（小写化后解析）；
    /// 不是的话（身份层将来换成别的 id 格式）按 SHA-256 派生一个稳定的 UUID ——
    /// 服务端用同一算法反推即可：`uuid(sha256("openkoto.appAccountToken:" + userId)[0..<16])`，
    /// 版本位 5、变体位 RFC 4122。
    public static func forUser(_ userID: String) -> UUID {
        if let uuid = UUID(uuidString: userID) { return uuid }
        var bytes = Array(SHA256.hash(data: Data("openkoto.appAccountToken:\(userID)".utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0F) | 0x50
        bytes[8] = (bytes[8] & 0x3F) | 0x80
        return UUID(
            uuid: (
                bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
            ))
    }
}
