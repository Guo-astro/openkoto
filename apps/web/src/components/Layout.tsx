import { Bot, BookOpen, Brain, Home, Languages, Library, LogOut, Menu, Music, User, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { setLanguage } from "../i18n";
import { cn } from "../lib/utils";
import { useSession } from "../lib/session";
import { ThemeToggle } from "./landing/LandingChrome";
import { SyncIndicator } from "./SyncIndicator";

const NAV = [
  { to: "/", key: "nav.home", icon: Home, end: true },
  { to: "/review", key: "nav.review", icon: Brain },
  { to: "/vocab", key: "nav.vocab", icon: BookOpen },
  { to: "/library", key: "nav.library", icon: Library },
  { to: "/lyrics", key: "nav.lyrics", icon: Music },
  { to: "/assistant", key: "nav.assistant", icon: Bot },
  { to: "/account", key: "nav.account", icon: User },
];

const LANGS = [
  { code: "zh", label: "中文" },
  { code: "en", label: "EN" },
  { code: "ja", label: "日本語" },
];

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  return (
    <label className="flex items-center gap-1 text-sm text-muted-foreground">
      <Languages size={16} aria-hidden />
      <select
        aria-label="Language"
        className="bg-transparent outline-none"
        value={i18n.language}
        onChange={(e) => setLanguage(e.target.value)}
      >
        {LANGS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RequireAuth() {
  const { account, loading } = useSession();
  const location = useLocation();
  const { t } = useTranslation();
  if (loading) return <div className="p-8 text-muted-foreground">{t("common.loading")}</div>;
  if (!account) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <Outlet />;
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { account, signOut } = useSession();
  const navigate = useNavigate();

  return (
    <div className="flex h-full flex-col gap-6 px-4 py-5">
      <NavLink to="/" className="flex items-center gap-2.5 rounded-full px-2" onClick={onNavigate}>
        <img src="/logo.png" alt="" className="h-8 w-8 rounded-full ring-1 ring-[var(--lp-line)]" />
        <span className="lp-display text-[19px]">OpenKoto</span>
      </NavLink>

      <nav className="flex flex-col gap-1" aria-label={t("public.nav.label")}>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-full px-3.5 py-2 text-[15px] transition-colors",
                isActive ? "bg-[var(--lp-mustard-soft)] text-[var(--lp-card-ink)]" : "text-[var(--lp-muted)] hover:bg-[var(--lp-line)] hover:text-[var(--lp-ink)]",
              )
            }
          >
            <item.icon size={17} strokeWidth={1.6} aria-hidden />
            {t(item.key)}
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto space-y-3 border-t border-[var(--lp-line)] pt-4">
        <div className="flex items-center justify-between gap-2 px-1">
          <SyncIndicator />
          <div className="flex items-center gap-1.5">
            <LanguageSwitcher />
            <ThemeToggle className="h-8 w-8" />
          </div>
        </div>
        {account ? (
          <>
            <NavLink to="/account" onClick={onNavigate} className="block rounded-xl px-2 py-1.5 hover:bg-[var(--lp-line)]">
              <p className="truncate text-[14px]">{account.user.email}</p>
              <p className="lp-tiny lp-muted mt-0.5">{t(`plan.${account.plan}`)}</p>
            </NavLink>
            <button
              type="button"
              className="lp-pill lp-pill-outline lp-pill-sm w-full"
              onClick={async () => {
                onNavigate?.();
                await signOut();
                navigate("/");
              }}
            >
              <LogOut size={14} aria-hidden /> {t("account.signOut")}
            </button>
          </>
        ) : (
          <Link to="/login" onClick={onNavigate} className="lp-pill lp-pill-sm w-full">
            {t("public.signIn")}
          </Link>
        )}
      </div>
    </div>
  );
}

/** Signed-in shell: sidebar on desktop, slide-in drawer on phones. Renders `children` when given (e.g. the home page at `/`), otherwise the route outlet. */
export function AppLayout({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  // Close the drawer whenever the route changes (back button included).
  useEffect(() => setOpen(false), [location.pathname]);

  return (
    <div className="lp min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-[var(--lp-line)] bg-[var(--sidebar)] md:block">
        <Sidebar />
      </aside>

      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-[var(--lp-line)] bg-[var(--lp-bg)]/90 px-4 backdrop-blur-md md:hidden">
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--lp-line)]"
          aria-label={t("public.nav.menu")}
          aria-expanded={open}
          aria-controls="app-drawer"
          onClick={() => setOpen(true)}
        >
          <Menu size={16} aria-hidden />
        </button>
        <NavLink to="/" className="flex items-center gap-2 rounded-full">
          <img src="/logo.png" alt="" className="h-7 w-7 rounded-full ring-1 ring-[var(--lp-line)]" />
          <span className="lp-display text-[17px]">OpenKoto</span>
        </NavLink>
        <div className="ml-auto">
          <SyncIndicator />
        </div>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" id="app-drawer">
          <button type="button" aria-label={t("common.close")} className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-[var(--sidebar)] shadow-xl">
            <button
              type="button"
              className="absolute right-3 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--lp-line)]"
              aria-label={t("common.close")}
              onClick={() => setOpen(false)}
            >
              <X size={16} aria-hidden />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}

      <div className="md:pl-60">
        <main className="app-main mx-auto w-full max-w-5xl px-4 py-6 md:px-10 md:py-10">{children ?? <Outlet />}</main>
      </div>
    </div>
  );
}
