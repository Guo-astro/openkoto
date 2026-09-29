import { Menu, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink } from "react-router";
import { GITHUB_URL, ISSUES_URL, RELEASES_URL } from "../lib/links";
import { useSession } from "../lib/session";
import { cn } from "../lib/utils";
import { LanguageSwitcher } from "./Layout";

/** GitHub mark (lucide dropped brand icons). */
export function GithubIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  );
}

/** Button look for links (the shared Button component renders a <button>). */
export function linkButton(variant: "default" | "outline" | "ghost" = "default", size: "sm" | "md" | "lg" = "md"): string {
  return cn(
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors whitespace-nowrap",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    variant === "default" && "bg-primary text-primary-foreground hover:bg-primary/90",
    variant === "outline" && "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
    variant === "ghost" && "text-foreground hover:bg-accent hover:text-accent-foreground",
    size === "sm" && "h-8 px-3 text-sm",
    size === "md" && "h-10 px-4 text-sm",
    size === "lg" && "h-12 px-6 text-base",
  );
}

const NAV = [
  { to: "/#features", key: "public.nav.features", hash: true },
  { to: "/docs", key: "public.nav.docs" },
  { to: "/updates", key: "public.nav.updates" },
  { to: "/pricing", key: "public.nav.pricing" },
];

export function PublicHeader() {
  const { t } = useTranslation();
  const { account } = useSession();
  const [open, setOpen] = useState(false);
  const navClass = ({ isActive }: { isActive: boolean }) =>
    cn("rounded-md px-3 py-1.5 text-sm transition-colors", isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground");

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold" onClick={() => setOpen(false)}>
          <img src="/logo.png" alt="" className="h-7 w-7 rounded-md" />
          <span>OpenKoto</span>
        </Link>
        <nav className="ml-4 hidden items-center gap-1 md:flex" aria-label={t("public.nav.label")}>
          {NAV.map((item) =>
            item.hash ? (
              <a key={item.to} href={item.to} className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
                {t(item.key)}
              </a>
            ) : (
              <NavLink key={item.to} to={item.to} className={navClass}>
                {t(item.key)}
              </NavLink>
            ),
          )}
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
            <GithubIcon size={15} /> GitHub
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden sm:block">
            <LanguageSwitcher />
          </div>
          <Link to={account ? "/" : "/login"} className={linkButton("default", "sm")}>
            {account ? t("public.openApp") : t("public.signIn")}
          </Link>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent md:hidden"
            aria-label={t("public.nav.menu")}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>
      {open && (
        <nav className="border-t border-border px-4 py-3 md:hidden" aria-label={t("public.nav.label")}>
          <div className="flex flex-col gap-1">
            {NAV.map((item) =>
              item.hash ? (
                <a key={item.to} href={item.to} className="rounded-md px-2 py-2 text-sm" onClick={() => setOpen(false)}>
                  {t(item.key)}
                </a>
              ) : (
                <Link key={item.to} to={item.to} className="rounded-md px-2 py-2 text-sm" onClick={() => setOpen(false)}>
                  {t(item.key)}
                </Link>
              ),
            )}
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="rounded-md px-2 py-2 text-sm">
              GitHub
            </a>
            <div className="px-2 py-2">
              <LanguageSwitcher />
            </div>
          </div>
        </nav>
      )}
    </header>
  );
}

export function PublicFooter() {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  const col = "space-y-2 text-sm";
  const link = "text-muted-foreground hover:text-foreground";
  return (
    <footer className="border-t border-border bg-muted/30">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 sm:grid-cols-2 md:grid-cols-4">
        <div className="space-y-3 sm:col-span-2 md:col-span-1">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <img src="/logo.png" alt="" className="h-7 w-7 rounded-md" /> OpenKoto
          </Link>
          <p className="text-sm text-muted-foreground">{t("public.footer.tagline")}</p>
        </div>
        <div className={col}>
          <p className="font-medium">{t("public.footer.product")}</p>
          <ul className={col}>
            <li><a href="/#features" className={link}>{t("public.nav.features")}</a></li>
            <li><Link to="/pricing" className={link}>{t("public.nav.pricing")}</Link></li>
            <li><a href="/#download" className={link}>{t("public.footer.download")}</a></li>
            <li><Link to="/updates" className={link}>{t("public.nav.updates")}</Link></li>
          </ul>
        </div>
        <div className={col}>
          <p className="font-medium">{t("public.footer.resources")}</p>
          <ul className={col}>
            <li><Link to="/docs" className={link}>{t("public.nav.docs")}</Link></li>
            <li><a href={GITHUB_URL} target="_blank" rel="noreferrer" className={link}>GitHub</a></li>
            <li><a href={RELEASES_URL} target="_blank" rel="noreferrer" className={link}>{t("public.footer.releases")}</a></li>
            <li><a href={ISSUES_URL} target="_blank" rel="noreferrer" className={link}>{t("public.footer.feedback")}</a></li>
          </ul>
        </div>
        <div className={col}>
          <p className="font-medium">{t("public.footer.legal")}</p>
          <ul className={col}>
            <li><Link to="/privacy" className={link}>{t("footer.privacy")}</Link></li>
            <li><Link to="/terms" className={link}>{t("footer.terms")}</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-border">
        <p className="mx-auto max-w-6xl px-4 py-4 text-xs text-muted-foreground">{t("public.footer.copyright", { year })}</p>
      </div>
    </footer>
  );
}

export function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col overflow-x-clip bg-background text-foreground">
      <PublicHeader />
      <main className="flex-1">{children}</main>
      <PublicFooter />
    </div>
  );
}
