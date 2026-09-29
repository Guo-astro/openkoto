#if os(iOS)
import OKAccount
import OKCommerce
import OKDesignSystem
import OKLocalization
import StoreKit
import SwiftUI

/// 会员与积分购买页（StoreKit 2）。价格一律取自 StoreKit，不在客户端写死。
struct PaywallView: View {
    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss

    let commerce: StoreManager
    let account: AccountSession

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent(L("settings.account.plan")) {
                        Text(verbatim: account.plan.rawValue.capitalized)
                    }
                } footer: {
                    Text(L("paywall.subtitle"))
                }

                if commerce.isLoading && commerce.products.isEmpty {
                    Section { ProgressView() }
                } else if let error = commerce.loadError, commerce.products.isEmpty {
                    Section {
                        Text(error).foregroundStyle(theme.destructive)
                        Button(L("paywall.retry")) { Task { await commerce.loadProducts() } }
                    }
                }

                productSection(L("paywall.plus"), [.plusMonthly, .plusYearly])
                productSection(L("paywall.pro"), [.proMonthly, .proYearly])
                productSection(L("paywall.credits"), [.credits3000])

                Section {
                    statusRow
                    Button(L("paywall.restore")) { Task { await commerce.restore() } }
                } footer: {
                    Text(L("paywall.legal"))
                }
            }
            .navigationTitle(L("paywall.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L("common.close")) { dismiss() }
                }
            }
            .task { await commerce.loadProducts() }
        }
    }

    @ViewBuilder
    private func productSection(_ title: String, _ ids: [CommerceProduct]) -> some View {
        let items = ids.compactMap { commerce.product($0) }
        if !items.isEmpty {
            Section(title) {
                ForEach(items, id: \.id) { product in
                    productRow(product)
                }
            }
        }
    }

    private func productRow(_ product: Product) -> some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(product.displayName)
                if !product.description.isEmpty {
                    Text(product.description)
                        .font(.caption)
                        .foregroundStyle(theme.mutedForeground)
                }
            }
            Spacer()
            Button {
                Task { await commerce.purchase(product) }
            } label: {
                if commerce.state == .purchasing(product.id) {
                    ProgressView().controlSize(.small)
                } else {
                    Text(verbatim: priceText(product))
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isBusy)
        }
    }

    private var isBusy: Bool {
        if case .purchasing = commerce.state { return true }
        return false
    }

    private func priceText(_ product: Product) -> String {
        guard let period = product.subscription?.subscriptionPeriod else { return product.displayPrice }
        let unit = period.unit == .year ? L("paywall.perYear") : L("paywall.perMonth")
        return "\(product.displayPrice)\(unit)"
    }

    @ViewBuilder
    private var statusRow: some View {
        switch commerce.state {
        case .idle, .purchasing:
            EmptyView()
        case .pending:
            Text(L("paywall.pending")).font(.footnote).foregroundStyle(theme.mutedForeground)
        case .succeeded:
            Text(L("paywall.success")).font(.footnote).foregroundStyle(theme.primary)
        case .failed(let message):
            Text(message).font(.footnote).foregroundStyle(theme.destructive)
        }
    }
}
#endif
