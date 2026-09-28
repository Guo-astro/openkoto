import { Bot, BookOpen, Brain, Home, Languages, Library, Music, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation, Navigate } from "react-router";
import { setLanguage } from "../i18n";
import { cn } from "../lib/utils";
import { useSession } from "../lib/session";
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

export function AppLayout() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 h-14">
          <NavLink to="/" className="flex items-center gap-2 font-semibold">
            <img src="/logo.png" alt="" className="h-7 w-7 rounded-md" />
            <span>OpenKoto</span>
          </NavLink>
          <nav className="hidden md:flex items-center gap-1 ml-4">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
                  )
                }
              >
                {t(item.key)}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <SyncIndicator />
            <LanguageSwitcher />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 pb-24 md:pb-6">
        <Outlet />
      </main>
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-20 border-t border-border bg-background/95 backdrop-blur">
        <div className="grid grid-cols-7">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn("flex flex-col items-center gap-0.5 py-2 text-[11px]", isActive ? "text-primary" : "text-muted-foreground")
              }
            >
              <item.icon size={20} aria-hidden />
              {t(item.key)}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
