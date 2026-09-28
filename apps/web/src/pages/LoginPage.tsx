import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { LanguageSwitcher } from "../components/Layout";
import { authApi, HttpError, type SocialProvider } from "../lib/api";
import { useSession } from "../lib/session";

/** Server-rendered routes (native app / CLI handoff) need a full page load, not client routing. */
function isServerRoute(path: string): boolean {
  return path.startsWith("/auth/") || path.startsWith("/api/");
}

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

const PROVIDER_LABEL: Record<SocialProvider, string> = { google: "Google", apple: "Apple", github: "GitHub" };

export function LoginPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const navigate = useNavigate();
  const { account, refresh } = useSession();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get("error") ? t("login.oauthError") : null);
  const [providers, setProviders] = useState<SocialProvider[]>([]);

  useEffect(() => {
    authApi
      .providers()
      .then((r) => setProviders(r.providers))
      .catch(() => setProviders([]));
  }, []);

  useEffect(() => {
    if (!account) return;
    if (isServerRoute(next)) window.location.assign(next);
    else navigate(next, { replace: true });
  }, [account, next, navigate]);

  const describe = (err: unknown) => {
    if (err instanceof HttpError) {
      if (err.status === 429) return t("login.tooMany");
      if (err.code === "INVALID_OTP" || err.code === "OTP_EXPIRED") return t("login.badCode");
      return err.message;
    }
    return t("common.networkError");
  };

  const sendCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authApi.sendOtp(email.trim());
      setStep("code");
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authApi.verifyOtp(email.trim(), otp.trim());
      await refresh();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const social = async (provider: SocialProvider) => {
    setBusy(true);
    setError(null);
    try {
      const res = await authApi.social(provider, next);
      if (res.url) window.location.assign(res.url);
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-end mb-6">
          <LanguageSwitcher />
        </div>
        <div className="flex flex-col items-center gap-3 mb-8">
          <img src="/logo.png" alt="" className="h-14 w-14 rounded-xl" />
          <h1 className="text-2xl font-semibold">{t("login.title")}</h1>
          <p className="text-sm text-muted-foreground text-center">{t("login.subtitle")}</p>
        </div>

        {step === "email" ? (
          <form onSubmit={sendCode} className="space-y-3">
            <Input
              type="email"
              required
              autoComplete="email"
              placeholder={t("login.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-label={t("login.email")}
            />
            <Button type="submit" className="w-full" disabled={busy || !email.includes("@")}>
              {t("login.sendCode")}
            </Button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-3">
            <p className="text-sm text-muted-foreground">{t("login.codeSent", { email })}</p>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              placeholder="000000"
              className="text-center tracking-[0.5em] text-lg"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              aria-label={t("login.code")}
              autoFocus
            />
            <Button type="submit" className="w-full" disabled={busy || otp.length !== 6}>
              {t("login.verify")}
            </Button>
            <button type="button" className="w-full text-sm text-muted-foreground hover:text-foreground" onClick={() => setStep("email")}>
              {t("login.changeEmail")}
            </button>
          </form>
        )}

        {providers.length > 0 && (
          <>
            <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
              <div className="h-px flex-1 bg-border" />
              {t("login.or")}
              <div className="h-px flex-1 bg-border" />
            </div>
            <div className="space-y-2">
              {providers.map((p) => (
                <Button key={p} variant="outline" className="w-full" disabled={busy} onClick={() => social(p)}>
                  {t("login.continueWith", { provider: PROVIDER_LABEL[p] })}
                </Button>
              ))}
            </div>
          </>
        )}

        {error && (
          <p role="alert" className="mt-4 text-sm text-destructive text-center">
            {error}
          </p>
        )}
        <p className="mt-8 text-xs text-muted-foreground text-center">{t("login.terms")}</p>
      </div>
    </div>
  );
}
