import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { accountApi, HttpError } from "../lib/api";

type Lookup = Awaited<ReturnType<typeof accountApi.lookupDevice>>;

/** Approves a CLI / TV-style device login (RFC 8628 verification page). */
export function DevicePage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("code") ?? "");
  const [found, setFound] = useState<Lookup | null>(null);
  const [status, setStatus] = useState<"idle" | "approved" | "denied">("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lookup = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setFound(await accountApi.lookupDevice(code));
    } catch (err) {
      setError(err instanceof HttpError && err.status === 404 ? t("device.notFound") : t("common.networkError"));
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approve: boolean) => {
    if (!found) return;
    setBusy(true);
    try {
      await accountApi.approveDevice(found.userCode, approve);
      setStatus(approve ? "approved" : "denied");
    } catch {
      setError(t("device.notFound"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md py-8">
      <h1 className="text-xl font-semibold mb-2">{t("device.title")}</h1>
      <p className="text-sm text-muted-foreground mb-6">{t("device.subtitle")}</p>

      {status !== "idle" ? (
        <div className="rounded-lg border border-border bg-card p-6 text-center">
          <p className="font-medium">{status === "approved" ? t("device.approved") : t("device.denied")}</p>
          <p className="text-sm text-muted-foreground mt-2">{t("device.closeTab")}</p>
        </div>
      ) : found ? (
        <div className="rounded-lg border border-border bg-card p-6 space-y-4">
          <p>{t("device.confirm", { name: found.device.name, platform: found.device.platform })}</p>
          <p className="font-mono text-2xl tracking-widest text-center">{found.userCode}</p>
          <p className="text-xs text-muted-foreground">{t("device.warning")}</p>
          <div className="flex gap-2">
            <Button className="flex-1" disabled={busy} onClick={() => decide(true)}>
              {t("device.approve")}
            </Button>
            <Button className="flex-1" variant="outline" disabled={busy} onClick={() => decide(false)}>
              {t("device.deny")}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={lookup} className="space-y-3">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD-EFGH"
            className="font-mono text-center text-lg tracking-widest"
            aria-label={t("device.codeLabel")}
            autoFocus
          />
          <Button type="submit" className="w-full" disabled={busy || code.replace(/[^0-9A-Z]/gi, "").length !== 8}>
            {t("device.continue")}
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
