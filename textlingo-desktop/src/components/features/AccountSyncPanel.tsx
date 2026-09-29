import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Cloud, ExternalLink, Loader2, LogIn, LogOut, RefreshCw } from "lucide-react";
import { Button } from "../ui/button";
import {
  CLOUD_EVENTS,
  accountUrl,
  cloudAccount,
  cloudLoginCancel,
  cloudLoginStart,
  cloudLogout,
  cloudResolveAccountSwitch,
  cloudSyncNow,
  cloudSyncStatus,
  type AuthChangedPayload,
  type CloudAccount,
  type SyncStatus,
} from "../../lib/cloud";

function formatTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** Settings → Account & Sync: OpenKoto cloud sign-in and sync status. */
export function AccountSyncPanel() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await cloudSyncStatus();
      setStatus(next);
      if (next.signedIn) {
        setAccount(await cloudAccount());
      } else {
        setAccount(null);
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unlisteners: Promise<UnlistenFn>[] = [
      listen<AuthChangedPayload>(CLOUD_EVENTS.authChanged, (event) => {
        setSigningIn(false);
        if (event.payload?.error) setError(event.payload.error);
        else setError(null);
        void refresh();
      }),
      listen<SyncStatus>(CLOUD_EVENTS.syncStatus, (event) => {
        if (event.payload) setStatus(event.payload);
      }),
    ];
    return () => {
      unlisteners.forEach((p) => {
        void p.then((unlisten) => unlisten()).catch(() => undefined);
      });
    };
  }, [refresh]);

  const handleSignIn = async () => {
    setError(null);
    setSigningIn(true);
    try {
      await cloudLoginStart();
    } catch (e) {
      setSigningIn(false);
      setError(String(e));
    }
  };

  const handleCancel = async () => {
    setSigningIn(false);
    await cloudLoginCancel().catch(() => undefined);
  };

  const handleSignOut = async () => {
    setError(null);
    try {
      await cloudLogout();
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const handleAccountChoice = async (upload: boolean) => {
    setError(null);
    setResolving(true);
    try {
      setStatus(await cloudResolveAccountSwitch(upload));
      void refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setResolving(false);
    }
  };

  const handleSyncNow = async () => {
    setError(null);
    setSyncing(true);
    try {
      setStatus(await cloudSyncNow());
    } catch (e) {
      setError(String(e));
      void refresh();
    } finally {
      setSyncing(false);
    }
  };

  const signedIn = !!status?.signedIn;
  const user = account?.user ?? status?.user ?? null;
  const plan = account?.plan ?? user?.plan ?? "free";
  const isSyncing = syncing || !!status?.syncing;
  const lastSync = formatTime(status?.lastSyncAt);
  const lastError = error ?? status?.lastError ?? null;
  const rejected = status?.lastReport?.rejected ?? [];
  const quotaRejected = rejected.filter((r) => r.code === "QUOTA_EXCEEDED").length;
  const pendingSwitch = status?.pendingAccountSwitch ?? null;
  const tokenInFile = signedIn && status?.tokenStorage === "file";

  return (
    <div className="space-y-6" data-testid="account-sync-panel">
      <div>
        <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
          <Cloud size={18} />
          {t("settings.account.title", "OpenKoto Account & Sync")}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "settings.account.desc",
            "Sign in to sync your vocabulary, word packs, review history, articles and bookmarks across desktop, iOS and web.",
          )}
        </p>
      </div>

      <div className="rounded-lg border border-border p-4 space-y-3">
        {signedIn ? (
          <>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm text-muted-foreground">{t("settings.account.signedInAs", "Signed in as")}</div>
                <div className="font-medium text-foreground truncate" data-testid="account-email">
                  {user?.email || user?.name || "—"}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t("settings.account.plan", "Plan")}:{" "}
                  <span className="uppercase font-medium text-foreground">{plan}</span>
                  {account?.offline && (
                    <span className="ml-2">({t("settings.account.offline", "offline")})</span>
                  )}
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={handleSignOut}>
                <LogOut size={14} className="mr-1.5" />
                {t("settings.account.signOut", "Sign out")}
              </Button>
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              onClick={() => void openUrl(accountUrl(status?.baseUrl))}
            >
              {t("settings.account.manage", "Manage account & subscription")}
              <ExternalLink size={12} />
            </button>
          </>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm text-muted-foreground">
              {signingIn
                ? t("settings.account.waitingForBrowser", "Finish signing in in your browser…")
                : t("settings.account.signedOut", "You are not signed in. Your data stays on this computer.")}
            </div>
            {signingIn ? (
              <div className="flex items-center gap-2">
                <Loader2 size={16} className="animate-spin text-muted-foreground" />
                <Button variant="ghost" size="sm" onClick={handleCancel}>
                  {t("settings.account.cancel", "Cancel")}
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={handleSignIn}>
                <LogIn size={14} className="mr-1.5" />
                {t("settings.account.signIn", "Sign in")}
              </Button>
            )}
          </div>
        )}
      </div>

      {signedIn && pendingSwitch && (
        <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 space-y-3" data-testid="account-switch">
          <div className="text-sm font-medium text-foreground">
            {t("settings.account.switchTitle", "Different account")}
          </div>
          <p className="text-sm text-muted-foreground">
            {t(
              "settings.account.switchDesc",
              "You signed in as {{email}}, but the data on this computer was synced with {{previous}}. Upload it to the new account, or keep it on this computer only? Nothing is uploaded until you choose.",
              { email: pendingSwitch.email, previous: pendingSwitch.previousEmail || pendingSwitch.previousUserId },
            )}
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={resolving} onClick={() => void handleAccountChoice(true)}>
              {t("settings.account.switchUpload", "Upload to this account")}
            </Button>
            <Button size="sm" variant="outline" disabled={resolving} onClick={() => void handleAccountChoice(false)}>
              {t("settings.account.switchLocalOnly", "Keep local only")}
            </Button>
          </div>
        </div>
      )}

      {tokenInFile && (
        <div className="flex gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-foreground" data-testid="token-file-warning">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
          <span>
            {t(
              "settings.account.tokenFileWarning",
              "No system keychain is available, so your sign-in is stored in an encrypted file readable only by your user account. Install a Secret Service (e.g. GNOME Keyring or KWallet) for stronger protection.",
            )}
          </span>
        </div>
      )}

      {signedIn && (
        <div className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-foreground">{t("settings.account.syncTitle", "Sync")}</div>
              <div className="text-xs text-muted-foreground" data-testid="sync-last">
                {isSyncing
                  ? t("settings.account.syncing", "Syncing…")
                  : lastSync
                    ? t("settings.account.lastSync", "Last synced: {{time}}", { time: lastSync })
                    : t("settings.account.neverSynced", "Not synced yet")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("settings.account.pending", "Pending changes: {{count}}", { count: status?.pendingChanges ?? 0 })}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={handleSyncNow} disabled={isSyncing}>
              <RefreshCw size={14} className={`mr-1.5 ${isSyncing ? "animate-spin" : ""}`} />
              {t("settings.account.syncNow", "Sync now")}
            </Button>
          </div>
          {quotaRejected > 0 && (
            <div className="text-xs text-amber-600 dark:text-amber-400">
              {t("settings.account.quotaExceeded", "{{count}} items were not uploaded because your plan limit was reached.", {
                count: quotaRejected,
              })}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {t("settings.account.autoSyncHint", "Sync runs automatically on start, a few seconds after changes and every 5 minutes. API keys are never synced.")}
          </p>
        </div>
      )}

      {lastError && (
        <div
          className="p-3 bg-destructive/10 border border-destructive/50 rounded-lg text-destructive text-sm break-words"
          data-testid="sync-error"
        >
          {t("settings.account.lastError", "Last error")}: {lastError}
        </div>
      )}
    </div>
  );
}
