import Foundation
import Observation
import OKAccount
import StoreKit
import os

/// StoreKit 2 购买流程。
///
/// 1. `loadProducts()` 从 App Store（或本地 `OpenKoto.storekit`）取价格；
/// 2. `purchase(_:)` 带上 `appAccountToken = 用户 id`，服务端据此把交易归到账号上
///    （App Store Server Notifications v2 也会带回这个 token）；
/// 3. 交易验签通过后把 JWS 交给服务端核验入账，**服务端确认之后才 `finish()`** ——
///    服务端没收到时交易留在队列里，下次启动 `Transaction.updates` 会再给一次；
/// 4. 刷新 `/me`，套餐 / 积分立刻反映到界面。
@MainActor
@Observable
public final class StoreManager {
    public enum PurchaseState: Equatable, Sendable {
        case idle
        case purchasing(String)
        case pending
        case succeeded(String)
        case failed(String)
    }

    public private(set) var products: [Product] = []
    public private(set) var isLoading = false
    public private(set) var state: PurchaseState = .idle
    public private(set) var loadError: String?

    @ObservationIgnored private let session: AccountSession
    @ObservationIgnored private let verifier: PurchaseVerifier
    @ObservationIgnored private var updatesTask: Task<Void, Never>?
    private let logger = Logger(subsystem: "app.openkoto", category: "Commerce")

    public init(session: AccountSession) {
        self.session = session
        self.verifier = PurchaseVerifier(api: session.api)
    }

    /// 监听交易更新（续订、家庭共享、上次没来得及入账的、在别处买的）。App 启动时调用一次。
    public func startObservingTransactions() {
        guard updatesTask == nil else { return }
        updatesTask = Task { [weak self] in
            for await result in Transaction.updates {
                await self?.handle(result)
            }
        }
    }

    public func loadProducts() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded = try await Product.products(for: CommerceProduct.allIDs)
            let order = CommerceProduct.allIDs
            products = loaded.sorted {
                (order.firstIndex(of: $0.id) ?? .max) < (order.firstIndex(of: $1.id) ?? .max)
            }
            loadError = products.isEmpty ? "No products available" : nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    public func product(_ id: CommerceProduct) -> Product? {
        products.first { $0.id == id.rawValue }
    }

    /// 买之前必须登录：没有账号，交易无处入账。
    public func purchase(_ product: Product) async {
        guard let user = session.user else {
            state = .failed("Sign in to purchase")
            return
        }
        state = .purchasing(product.id)
        do {
            let result = try await product.purchase(options: [
                .appAccountToken(AppAccountToken.forUser(user.id))
            ])
            switch result {
            case .success(let verification):
                await handle(verification)
            case .pending:
                // 家长审批 / 需要额外验证。批下来之后走 `Transaction.updates`。
                state = .pending
            case .userCancelled:
                state = .idle
            @unknown default:
                state = .idle
            }
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// 恢复购买：让 App Store 把这个 Apple ID 的交易重新同步一遍，逐条交给服务端。
    public func restore() async {
        do {
            try await AppStore.sync()
            for await result in Transaction.currentEntitlements {
                await handle(result, finish: false)
            }
            await session.refreshAccount()
            state = .idle
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func handle(_ result: VerificationResult<Transaction>, finish: Bool = true) async {
        guard case .verified(let transaction) = result else {
            // 本地验签失败：可能是越狱改包 / 伪造的收据。不入账、不 finish。
            logger.error("unverified transaction ignored")
            state = .failed("Transaction could not be verified")
            return
        }
        do {
            try await verifier.verify(
                jws: result.jwsRepresentation, productID: transaction.productID,
                transactionID: String(transaction.id), appAccountToken: transaction.appAccountToken)
            if finish { await transaction.finish() }
            await session.refreshAccount()
            state = .succeeded(transaction.productID)
        } catch {
            // 不 finish：服务端没入账前交易留在队列里，下次还会再来。
            logger.error("server verification failed: \(error.localizedDescription, privacy: .public)")
            state = .failed(error.localizedDescription)
        }
    }
}
