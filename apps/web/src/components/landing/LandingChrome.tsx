import { Menu, X } from "lucide-react";
import { useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router";
import { setLanguage } from "../../i18n";
import { GITHUB_URL, ISSUES_URL, RELEASES_URL } from "../../lib/links";
import { useSession } from "../../lib/session";
import { cn } from "../../lib/utils";

const LANGS = [
  { code: "zh", label: "中文" },
  { code: "en", label: "EN" },
  { code: "ja", label: "日本語" },
];

/** Headline markup (`<em>` accent word, `<br/>` line break) shared by every landing heading. */
export function Headline({ i18nKey }: { i18nKey: string }) {
  return <Trans i18nKey={i18nKey} components={{ em: <em className="lp-em" />, br: <br /> }} />;
}

function LangSelect({ className }: { className?: string }) {
  const { i18n } = useTranslation();
  return (
    <select
      aria-label="Language"
      value={i18n.language}
      onChange={(e) => setLanguage(e.target.value)}
      className={cn("lp-tiny cursor-pointer rounded-full border border-[var(--lp-line)] bg-transparent px-2.5 py-1.5 hover:border-current", className)}
    >
      {LANGS.map((l) => (
        <option key={l.code} value={l.code} className="text-black">
          {l.label}
        </option>
      ))}
    </select>
  );
}

export function LandingHeader() {
  const { t } = useTranslation();
  const { account } = useSession();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const items = [
    { href: "#features", label: t("public.nav.features") },
    { to: "/docs", label: t("public.nav.docs") },
    { to: "/updates", label: t("public.nav.updates") },
    { to: "/pricing", label: t("public.nav.pricing") },
    { href: GITHUB_URL, label: "GitHub", external: true },
  ];
  const linkCls = "lp-tiny rounded-full px-2 py-1 transition-opacity hover:opacity-60";

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--lp-line)] bg-[var(--lp-bg)]/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1240px] items-center gap-4 px-5 md:px-10">
        <Link to="/" className="flex items-center gap-2.5 rounded-full" onClick={close}>
          <img src="/logo.png" alt="" className="h-8 w-8 rounded-full ring-1 ring-[var(--lp-line)]" />
          <span className="lp-display text-[19px]">OpenKoto</span>
        </Link>
        <nav className="ml-auto hidden items-center gap-3 lg:flex" aria-label={t("public.nav.label")}>
          {items.map((item) =>
            item.to ? (
              <Link key={item.label} to={item.to} className={linkCls}>
                {item.label}
              </Link>
            ) : (
              <a key={item.label} href={item.href} className={linkCls} {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}>
                {item.label}
              </a>
            ),
          )}
        </nav>
        <div className="ml-auto flex items-center gap-2 lg:ml-2">
          <LangSelect className="hidden sm:block" />
          <Link to={account ? "/" : "/login"} className="lp-pill lp-pill-sm">
            {account ? t("public.openApp") : t("public.signIn")}
          </Link>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[var(--lp-line)] lg:hidden"
            aria-label={t("public.nav.menu")}
            aria-expanded={open}
            aria-controls="lp-mobile-nav"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X size={16} aria-hidden /> : <Menu size={16} aria-hidden />}
          </button>
        </div>
      </div>
      {open && (
        <nav id="lp-mobile-nav" className="border-t border-[var(--lp-line)] px-5 pb-6 pt-2 lg:hidden" aria-label={t("public.nav.label")}>
          <ul className="flex flex-col">
            {items.map((item) => (
              <li key={item.label} className="border-b border-[var(--lp-line)]">
                {item.to ? (
                  <Link to={item.to} className="lp-tiny block py-4" onClick={close}>
                    {item.label}
                  </Link>
                ) : (
                  <a href={item.href} className="lp-tiny block py-4" onClick={close} {...(item.external ? { target: "_blank", rel: "noreferrer" } : {})}>
                    {item.label}
                  </a>
                )}
              </li>
            ))}
          </ul>
          <LangSelect className="mt-5 sm:hidden" />
        </nav>
      )}
    </header>
  );
}

export function LandingFooter() {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  const head = "lp-tiny mb-4 lp-muted";
  const link = "lp-link text-[15px]";
  return (
    <footer className="border-t border-[var(--lp-line)]">
      <div className="mx-auto grid max-w-[1240px] gap-12 px-5 py-16 md:grid-cols-[1.4fr_1fr_1fr_1fr] md:px-10 md:py-20">
        <div className="space-y-6">
          <Link to="/" className="inline-flex rounded-full" aria-label="OpenKoto">
            <span className="flex h-16 w-16 items-center justify-center rounded-full border border-current">
              <img src="/logo.png" alt="" className="h-11 w-11 rounded-full" />
            </span>
          </Link>
          <p className="lp-display max-w-xs text-[22px] leading-snug">
            <Headline i18nKey="landing.hero.headline" />
          </p>
          <p className="lp-muted max-w-xs text-[15px]">{t("public.footer.tagline")}</p>
        </div>
        <div>
          <p className={head}>{t("public.footer.product")}</p>
          <ul className="space-y-2.5">
            <li><a href="#features" className={link}>{t("public.nav.features")}</a></li>
            <li><Link to="/pricing" className={link}>{t("public.nav.pricing")}</Link></li>
            <li><a href="#download" className={link}>{t("public.footer.download")}</a></li>
            <li><Link to="/updates" className={link}>{t("public.nav.updates")}</Link></li>
          </ul>
        </div>
        <div>
          <p className={head}>{t("public.footer.resources")}</p>
          <ul className="space-y-2.5">
            <li><Link to="/docs" className={link}>{t("public.nav.docs")}</Link></li>
            <li><a href={GITHUB_URL} target="_blank" rel="noreferrer" className={link}>GitHub</a></li>
            <li><a href={RELEASES_URL} target="_blank" rel="noreferrer" className={link}>{t("public.footer.releases")}</a></li>
            <li><a href={ISSUES_URL} target="_blank" rel="noreferrer" className={link}>{t("public.footer.feedback")}</a></li>
          </ul>
        </div>
        <div>
          <p className={head}>{t("public.footer.legal")}</p>
          <ul className="space-y-2.5">
            <li><Link to="/privacy" className={link}>{t("footer.privacy")}</Link></li>
            <li><Link to="/terms" className={link}>{t("footer.terms")}</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-[var(--lp-line)]">
        <p className="lp-tiny lp-muted mx-auto max-w-[1240px] px-5 py-6 md:px-10">{t("public.footer.copyright", { year })}</p>
      </div>
    </footer>
  );
}
