import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Button } from "../components/ui/button";
import { HttpError, request } from "../lib/api";

interface ClientInfo {
  clientId: string;
  clientName: string;
  redirectUri: string;
  redirectHost: string;
  scopes: string[];
}

/** OAuth consent for remote MCP clients (server: server/worker/src/mcp/oauth.ts). */
export function OAuthConsentPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [client, setClient] = useState<ClientInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    request<ClientInfo>(`/api/v1/oauth/client?${params.toString()}`)
      .then(setClient)
      .catch((err) => setError(err instanceof HttpError && err.status < 500 ? t("oauth.invalid") : t("common.networkError")));
  }, [params, t]);

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      const res = await request<{ redirectTo: string }>("/api/v1/oauth/decision", {
        method: "POST",
        body: JSON.stringify({ ...Object.fromEntries(params), approve }),
      });
      window.location.assign(res.redirectTo);
    } catch {
      setError(t("oauth.invalid"));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md py-8">
      <h1 className="text-xl font-semibold mb-2">{t("oauth.title")}</h1>
      {client && (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4">
          <p>{t("oauth.confirm", { name: client.clientName })}</p>
          <p className="text-sm text-muted-foreground">{t("oauth.redirect", { host: client.redirectHost })}</p>
          <ul className="text-sm list-disc pl-5 space-y-1">
            <li>{t("oauth.scopeRead")}</li>
            <li>{t("oauth.scopeWrite")}</li>
            <li>{t("oauth.scopeAi")}</li>
          </ul>
          <p className="text-xs text-muted-foreground">{t("oauth.warning")}</p>
          <div className="flex gap-2">
            <Button className="flex-1" disabled={busy} onClick={() => decide(true)}>
              {t("oauth.approve")}
            </Button>
            <Button className="flex-1" variant="outline" disabled={busy} onClick={() => decide(false)}>
              {t("oauth.deny")}
            </Button>
          </div>
        </div>
      )}
      {!client && !error && <p className="text-muted-foreground">{t("common.loading")}</p>}
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
