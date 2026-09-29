import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { Button } from "../components/ui/button";
import { request } from "../lib/api";
import { useSession } from "../lib/session";

interface Sku {
  id: string;
  kind: "subscription" | "credits";
  plan?: "plus" | "pro";
  priceCny: number;
  priceUsd?: number;
  credits?: number;
  web: boolean;
}

const TIERS = [
  { plan: "free", features: ["pricing.f.local", "pricing.f.syncFree", "pricing.f.byok"] },
  { plan: "plus", features: ["pricing.f.local", "pricing.f.syncPlus", "pricing.f.cli", "pricing.f.guide", "pricing.f.topup"] },
  { plan: "pro", features: ["pricing.f.local", "pricing.f.syncPro", "pricing.f.cli", "pricing.f.credits", "pricing.f.agent"] },
] as const;

export function PricingPage() {
  const { t } = useTranslation();
  const { account } = useSession();
  const navigate = useNavigate();
  const [skus, setSkus] = useState<Sku[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    request<{ skus: Sku[] }>("/api/v1/billing/plans")
      .then((r) => setSkus(r.skus))
      .catch(() => setSkus([]));
  }, []);

  const buy = async (skuId: string) => {
    if (!account) {
      navigate(`/login?next=${encodeURIComponent("/pricing")}`);
      return;
    }
    setBusy(skuId);
    setError(null);
    try {
      const { url } = await request<{ url: string }>("/api/v1/billing/checkout", { method: "POST", body: JSON.stringify({ sku: skuId }) });
      window.location.assign(url);
    } catch {
      setError(t("pricing.checkoutFailed"));
      setBusy(null);
    }
  };

  const skusFor = (plan: string) => skus.filter((s) => s.plan === plan);
  const creditPack = skus.find((s) => s.kind === "credits");

  return (
    <div className="space-y-8">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-semibold">{t("pricing.title")}</h1>
        <p className="text-muted-foreground">{t("pricing.subtitle")}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {TIERS.map((tier) => (
          <div
            key={tier.plan}
            className={`rounded-xl border bg-card p-5 flex flex-col gap-4 ${tier.plan === "plus" ? "border-primary shadow-sm" : "border-border"}`}
          >
            <div>
              <h2 className="font-semibold text-lg">{t(`plan.${tier.plan}`)}</h2>
              <p className="text-sm text-muted-foreground">{t(`pricing.tagline.${tier.plan}`)}</p>
            </div>
            <ul className="space-y-2 text-sm flex-1">
              {tier.features.map((f) => (
                <li key={f} className="flex gap-2">
                  <Check size={16} className="text-primary shrink-0 mt-0.5" aria-hidden />
                  {t(f)}
                </li>
              ))}
            </ul>
            <div className="space-y-2">
              {tier.plan === "free" ? (
                <p className="text-2xl font-semibold">¥0</p>
              ) : (
                skusFor(tier.plan).map((sku) => (
                  <div key={sku.id} className="flex items-center justify-between gap-2">
                    <span>
                      <span className="text-xl font-semibold">¥{sku.priceCny}</span>
                      <span className="text-sm text-muted-foreground"> / {t(sku.id.endsWith("year") ? "pricing.year" : "pricing.month")}</span>
                      {sku.web && sku.priceUsd && <span className="block text-xs text-muted-foreground">{t("pricing.usd", { price: sku.priceUsd })}</span>}
                    </span>
                    {sku.web ? (
                      <Button size="sm" disabled={busy !== null || account?.plan === tier.plan} onClick={() => buy(sku.id)}>
                        {account?.plan === tier.plan ? t("pricing.current") : t("pricing.buy")}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("pricing.appStoreOnly")}</span>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
      {creditPack && (
        <div className="rounded-xl border border-border bg-card p-5 flex flex-wrap items-center gap-4">
          <div className="flex-1">
            <h2 className="font-semibold">{t("pricing.creditsTitle")}</h2>
            <p className="text-sm text-muted-foreground">{t("pricing.creditsDesc", { credits: creditPack.credits, price: creditPack.priceCny })}</p>
          </div>
          {creditPack.web && (
            <Button variant="secondary" disabled={busy !== null} onClick={() => buy(creditPack.id)}>
              {t("pricing.buyCredits")}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive text-center">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground text-center">
        {t("pricing.notes")} <Link to="/terms" className="underline">{t("footer.terms")}</Link>
      </p>
    </div>
  );
}
