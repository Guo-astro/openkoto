import { Laptop, Smartphone } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Button } from "../components/ui/button";
import { request } from "../lib/api";
import { useSession } from "../lib/session";

/** Consent step for the iOS / desktop apps' sign-in (a code is only issued after "Allow"). */
export function AuthorizeAppPage() {
  const { t } = useTranslation();
  const { account } = useSession();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clientId = params.get("client_id") ?? "";
  const app = clientId === "desktop" ? t("authorizeApp.desktop") : clientId === "android" ? "Android" : t("authorizeApp.ios");
  const Icon = clientId === "desktop" ? Laptop : Smartphone;

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...Object.fromEntries(params), approve: String(approve) };
      const { redirect } = await request<{ redirect: string }>("/api/v1/auth/native/approve", { method: "POST", body: JSON.stringify(body) });
      window.location.assign(redirect);
    } catch {
      setError(t("authorizeApp.failed"));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md py-10">
      <div className="rounded-2xl border border-border bg-card p-6 space-y-5 text-center">
        <Icon size={40} className="mx-auto text-primary" aria-hidden />
        <h1 className="text-xl font-semibold">{t("authorizeApp.title", { app })}</h1>
        <p className="text-sm text-muted-foreground">{t("authorizeApp.body", { app, email: account?.user.email })}</p>
        <p className="text-xs text-muted-foreground">{t("authorizeApp.warning")}</p>
        <div className="flex gap-2">
          <Button className="flex-1" disabled={busy} onClick={() => void decide(true)}>
            {t("authorizeApp.allow")}
          </Button>
          <Button className="flex-1" variant="outline" disabled={busy} onClick={() => void decide(false)}>
            {t("common.cancel")}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
