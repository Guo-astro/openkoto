import { Copy, KeyRound, Laptop, LogOut, Monitor, Smartphone, Terminal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { accountApi, HttpError, type ApiKey, type Device } from "../lib/api";
import { useSession } from "../lib/session";

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="rounded-xl border border-border bg-card p-5 space-y-4">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const PLATFORM_ICON: Record<string, typeof Laptop> = { ios: Smartphone, android: Smartphone, cli: Terminal, windows: Monitor, macos: Laptop, linux: Monitor };

export function AccountPage() {
  const { t, i18n } = useTranslation();
  const { account, refresh, signOut } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [devices, setDevices] = useState<Device[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(params.get("delete") === "1");

  const load = useCallback(async () => {
    const [d, k] = await Promise.all([accountApi.devices(), account?.entitlements.apiKeys ? accountApi.keys() : Promise.resolve(null)]);
    setDevices(d.devices);
    if (k) setKeys(k.keys);
  }, [account?.entitlements.apiKeys]);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  if (!account) return null;
  const date = (iso: string) => new Date(iso).toLocaleDateString(i18n.language);

  const redeem = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const res = await accountApi.redeem(code.trim());
      setMessage(t("account.redeemed", { plan: res.plan ? t(`plan.${res.plan}`) : "—", credits: res.credits }));
      setCode("");
      await refresh();
    } catch (err) {
      setMessage(err instanceof HttpError ? t("account.redeemFailed") : t("common.networkError"));
    }
  };

  const createKey = async (e: FormEvent) => {
    e.preventDefault();
    const created = await accountApi.createKey(keyName || "CLI", ["sync", "vocab:read", "vocab:write", "library:read", "library:write"]);
    setNewKey(created.key);
    setKeyName("");
    await load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{account.user.email}</h1>
          <p className="text-sm text-muted-foreground">{t("account.memberSince", { date: date(account.user.createdAt) })}</p>
        </div>
        <Button
          variant="outline"
          onClick={async () => {
            await signOut();
            navigate("/login");
          }}
        >
          <LogOut size={16} /> {t("account.signOut")}
        </Button>
      </div>

      <Section title={t("account.membership")}>
        <div className="flex flex-wrap items-center gap-4">
          <span className="rounded-full bg-primary/10 text-primary px-3 py-1 text-sm font-medium">{t(`plan.${account.plan}`)}</span>
          <span className="text-sm text-muted-foreground">{t("account.credits", { count: account.credits })}</span>
          <Link to="/pricing" className="ml-auto text-sm text-primary hover:underline">
            {account.plan === "free" ? t("account.upgrade") : t("account.manage")}
          </Link>
        </div>
        {account.subscriptions.map((s) => (
          <p key={`${s.channel}-${s.periodEnd}`} className="text-sm text-muted-foreground">
            {t("account.subscriptionLine", { plan: t(`plan.${s.plan}`), channel: t(`channel.${s.channel}`, s.channel), date: date(s.periodEnd) })}
          </p>
        ))}
        <form onSubmit={redeem} className="flex gap-2">
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("account.redeemPlaceholder")} aria-label={t("account.redeem")} />
          <Button type="submit" variant="secondary" disabled={!code.trim()}>
            {t("account.redeem")}
          </Button>
        </form>
        {message && <p className="text-sm">{message}</p>}
      </Section>

      <Section title={t("account.devices")}>
        <ul className="divide-y divide-border">
          {devices.map((d) => {
            const Icon = PLATFORM_ICON[d.platform] ?? Laptop;
            return (
              <li key={d.id} className="flex items-center gap-3 py-2">
                <Icon size={18} className="text-muted-foreground" aria-hidden />
                <div className="flex-1 min-w-0">
                  <p className="truncate">{d.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.platform} · {t("account.lastSeen", { date: date(d.lastSeenAt) })}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => accountApi.revokeDevice(d.id).then(load)}>
                  {t("account.revoke")}
                </Button>
              </li>
            );
          })}
          {devices.length === 0 && <li className="py-2 text-sm text-muted-foreground">{t("account.noDevices")}</li>}
        </ul>
      </Section>

      <Section title={t("account.apiKeys")}>
        {account.entitlements.apiKeys ? (
          <>
            <p className="text-sm text-muted-foreground">{t("account.apiKeysHint")}</p>
            {newKey && (
              <div className="rounded-md border border-primary/40 bg-primary/5 p-3 space-y-2">
                <p className="text-sm">{t("account.keyOnce")}</p>
                <div className="flex gap-2 items-center">
                  <code className="flex-1 truncate font-mono text-sm">{newKey}</code>
                  <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(newKey)}>
                    <Copy size={14} />
                  </Button>
                </div>
              </div>
            )}
            <ul className="divide-y divide-border">
              {keys.map((k) => (
                <li key={k.id} className="flex items-center gap-3 py-2">
                  <KeyRound size={16} className="text-muted-foreground" aria-hidden />
                  <div className="flex-1 min-w-0">
                    <p className="truncate">{k.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{k.prefix}… · {k.scopes.join(", ")}</p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => accountApi.revokeKey(k.id).then(load)}>
                    {t("account.revoke")}
                  </Button>
                </li>
              ))}
            </ul>
            <form onSubmit={createKey} className="flex gap-2">
              <Input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder={t("account.keyName")} aria-label={t("account.keyName")} />
              <Button type="submit">{t("account.createKey")}</Button>
            </form>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("account.apiKeysLocked")}{" "}
            <Link to="/pricing" className="text-primary hover:underline">
              {t("account.upgrade")}
            </Link>
          </p>
        )}
      </Section>

      <Section title={t("account.dangerZone")} id="delete">
        {account.pendingDeletion ? (
          <div className="space-y-2">
            <p className="text-sm">{t("account.deletionScheduled", { date: date(account.pendingDeletion) })}</p>
            <Button variant="outline" onClick={() => accountApi.cancelDeletion().then(refresh)}>
              {t("account.cancelDeletion")}
            </Button>
          </div>
        ) : confirmDelete ? (
          <div className="space-y-3">
            <p className="text-sm">{t("account.deleteWarning")}</p>
            <div className="flex gap-2">
              <Button variant="danger" onClick={() => accountApi.requestDeletion().then(refresh)}>
                <Trash2 size={16} /> {t("account.deleteConfirm")}
              </Button>
              <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
            {t("account.delete")}
          </Button>
        )}
      </Section>
    </div>
  );
}
