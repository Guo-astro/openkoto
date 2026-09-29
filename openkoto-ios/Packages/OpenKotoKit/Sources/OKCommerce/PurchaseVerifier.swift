import Foundation
import OKAccount

/// 把 App Store 交易交给服务端核验并入账：`POST /api/v1/billing/appstore/verify`。
///
/// 请求体 `{ "signedTransaction": "<JWS>", "productId", "transactionId", "appAccountToken" }`；
/// 服务端以 JWS 为准（验签 + 查 App Store Server API），其余字段只是方便日志与排查。
public struct PurchaseVerifier: Sendable {
    public let api: CloudAPIClient

    public init(api: CloudAPIClient) {
        self.api = api
    }

    public struct Request: Codable, Sendable, Equatable {
        public var signedTransaction: String
        public var productId: String
        public var transactionId: String
        public var appAccountToken: String?
    }

    public struct Response: Codable, Sendable, Equatable {
        public var ok: Bool?
        public var plan: Plan?
        public var credits: Double?
    }

    @discardableResult
    public func verify(
        jws: String, productID: String, transactionID: String, appAccountToken: UUID?
    ) async throws -> Response {
        let body = Request(
            signedTransaction: jws, productId: productID, transactionId: transactionID,
            appAccountToken: appAccountToken?.uuidString.lowercased())
        return try await api.send(
            .init(method: "POST", path: "api/v1/billing/appstore/verify",
                  body: try JSONEncoder().encode(body)),
            as: Response.self)
    }
}
