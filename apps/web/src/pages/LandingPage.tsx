
import { ArrowUpRight, Globe, Monitor, Plus, Smartphone, Terminal } from "lucide-react";
import { useEffect, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { HeroMock } from "../components/landing/HeroMock";
import { Headline, LandingFooter, LandingHeader } from "../components/landing/LandingChrome";
import { buttonVariants } from "../components/ui/button";
import {
  BannerPattern,
  DevicesIllustration,
  FlashcardsIllustration,
  GuideThumb,
  BookFlightIllustration,
  MicrophoneIllustration,
  NewspaperThumb,
  OpenBookIllustration,
} from "../components/landing/illustrations";
import { contentLang, listDocs, listUpdates } from "../lib/content";
import { cn } from "../lib/utils";
import { APP_STORE_URL, GITHUB_URL, RELEASES_URL, SKILL_URL } from "../lib/links";

type Illo = ComponentType<{ className?: string }>;

// Four quiet tints that share one lightness (see landing.css), one per feature.
const FOCUS: { key: string; bg: string; Illo: Illo }[] = [
  { key: "review", bg: "var(--lp-honey)", Illo: FlashcardsIllustration },
  { key: "novels", bg: "var(--lp-clay)", Illo: OpenBookIllustration },
  { key: "lyrics", bg: "var(--lp-mist)", Illo: MicrophoneIllustration },
  { key: "sync", bg: "var(--lp-sage)", Illo: DevicesIllustration },
];

const FAQ = ["what", "free", "platforms", "privacy", "ai", "agents"] as const;

const container = "mx-auto w-full max-w-[1240px] px-5 md:px-10";

/** Internal route, in-page anchor or external URL, rendered with the right element. */
function SmartLink({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  if (href.startsWith("/")) {
    return (
      <Link to={href} className={className}>
        {children}
      </Link>
    );
  }
  const external = href.startsWith("http");
  return (
    <a href={href} className={className} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
      {children}
    </a>
  );
}

function AppleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M16.37 12.75c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.47.83-.72 0-1.82-.81-2.99-.79-1.54.02-2.96.9-3.75 2.27-1.6 2.78-.41 6.89 1.15 9.14.76 1.1 1.67 2.34 2.86 2.3 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.77.74 2.98.72 1.23-.02 2.02-1.12 2.77-2.23.87-1.28 1.23-2.52 1.25-2.58-.03-.01-2.39-.92-2.41-3.66ZM14.1 6c.63-.77 1.06-1.83.94-2.9-.91.04-2.02.61-2.67 1.37-.58.67-1.1 1.76-.96 2.8 1.02.08 2.06-.52 2.69-1.27Z" />
    </svg>
  );
}

/** Round icon-only download button; widens on hover/focus to say which build it downloads. */
function DownloadDot({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="lp-dl" aria-label={label} title={label}>
      {children}
      <span className="lp-dl-label" aria-hidden>
        {label}
      </span>
    </a>
  );
}

export function LandingPage() {
  const { t, i18n } = useTranslation();
  const lang = contentLang(i18n.language);

  useEffect(() => {
    document.title = `OpenKoto — ${t("landing.meta.title")}`;
  }, [t]);

  // Links from other pages land on `/#features` etc. before this page has rendered; scroll once it has.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  const notes = [
    ...listUpdates(lang)
      .slice(0, 2)
      .map((d) => ({ kind: "update" as const, href: "/updates", title: d.title, desc: d.description, date: d.date })),
    ...listDocs(lang)
      .slice(0, 2)
      .map((d) => ({ kind: "doc" as const, href: d.slug === "index" ? "/docs" : `/docs/${d.slug}`, title: d.title, desc: d.description, date: undefined })),
  ];
  const noteBg = ["var(--lp-mist)", "var(--lp-honey)", "var(--lp-clay)", "var(--lp-sage)"];

  const platforms = [
    { key: "web", Icon: Globe, href: "/login" },
    { key: "ios", Icon: Smartphone, href: APP_STORE_URL },
    { key: "desktop", Icon: Monitor, href: RELEASES_URL },
    { key: "cli", Icon: Terminal, href: SKILL_URL },
  ];

  return (
    <div className="lp flex min-h-screen flex-col overflow-x-clip">
      <LandingHeader />
      <main className="flex-1">
        {/* 1 · Hero — copy and a product sketch share the first screen: side by side on desktop, stacked on phones. */}
        <section
          className={`${container} grid grid-cols-1 items-center gap-6 pt-8 pb-10 md:pt-12 lg:grid-cols-[1.1fr_1fr] lg:gap-8 lg:pt-14 lg:pb-16`}
        >
          <div className="min-w-0 text-center lg:text-left">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="lp-tiny lp-muted inline-flex max-w-full items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 hover:text-foreground"
            >
              {t("landing.hero.badge")} <ArrowUpRight size={12} aria-hidden />
            </a>
            <h1 className="lp-h1 lp-hero-title mx-auto mt-5 lg:mx-0 lg:mt-7">
              <Headline i18nKey="landing.hero.headline" />
            </h1>
            <p className="lp-muted mx-auto mt-4 max-w-xl text-[16px] md:text-[18px] lg:mx-0 lg:mt-6">{t("landing.hero.subtitle")}</p>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-3 lg:mt-9 lg:justify-start">
              <Link to="/login" className={buttonVariants({ size: "lg" })}>
                {t("landing.hero.start")}
              </Link>
              <DownloadDot href={APP_STORE_URL} label={t("landing.hero.dlIos")}>
                <AppleLogo />
              </DownloadDot>
              <DownloadDot href={RELEASES_URL} label={t("landing.hero.dlDesktop")}>
                <Monitor size={18} strokeWidth={1.5} aria-hidden />
              </DownloadDot>
            </div>
          </div>
          <HeroMock className="w-full" />
        </section>

        {/* 2 · Band */}
        <section className="bg-band py-20 md:py-24">
          <div className={`${container} text-center`}>
            <h2 className="lp-h2 mx-auto max-w-4xl">
              <Headline i18nKey="landing.band.headline" />
            </h2>
            <BookFlightIllustration className="lp-float mx-auto mt-10 w-full max-w-[520px]" />
            <a href="#features" className={cn(buttonVariants({ variant: "outline", size: "lg" }), "mt-8")}>
              {t("landing.band.cta")}
            </a>
          </div>
        </section>

        {/* 3 · Features */}
        <section id="features" className={`${container} scroll-mt-20 py-20 md:py-28`}>
          <p className="lp-eyebrow lp-muted text-center">{t("landing.focus.eyebrow")}</p>
          <h2 className="lp-h2 mx-auto mt-5 max-w-3xl text-center">
            <Headline i18nKey="landing.focus.title" />
          </h2>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {FOCUS.map(({ key, bg, Illo }) => (
              <article key={key} className="lp-card flex flex-col rounded-[18px] p-6" style={{ background: bg }}>
                <Illo className="mx-auto aspect-[11/8] w-full max-w-[240px]" />
                <h3 className="lp-display mt-5 text-[21px] leading-tight">{t(`landing.focus.cards.${key}.title`)}</h3>
                <p className="lp-muted mt-2 text-[15.5px] leading-relaxed">{t(`landing.focus.cards.${key}.desc`)}</p>
              </article>
            ))}
          </div>
        </section>

        {/* 4 · Download */}
        <section id="download" className={`${container} scroll-mt-20 py-20 md:py-28`}>
          <p className="lp-eyebrow lp-muted text-center">{t("landing.download.eyebrow")}</p>
          <h2 className="lp-h2 mx-auto mt-5 max-w-3xl text-center">
            <Headline i18nKey="landing.download.headline" />
          </h2>
          <ul className="mt-14 grid gap-px overflow-hidden rounded-[18px] border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
            {platforms.map(({ key, Icon, href }) => (
              <li key={key} className="flex flex-col bg-background p-7">
                <Icon size={26} strokeWidth={1.3} aria-hidden />
                <h3 className="lp-display mt-5 text-[20px]">{t(`landing.download.${key}.title`)}</h3>
                <p className="lp-muted mt-2 flex-1 text-[15.5px]">{t(`landing.download.${key}.desc`)}</p>
                <SmartLink href={href} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-6 self-start")}>
                  {t(`landing.download.${key}.cta`)}
                </SmartLink>
              </li>
            ))}
          </ul>
        </section>

        {/* 5 · Updates & docs */}
        <section className="border-t border-line py-20 md:py-28" aria-labelledby="lp-notes">
          <div className={container}>
            <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
              <div>
                <p className="lp-eyebrow lp-muted">{t("landing.notes.eyebrow")}</p>
                <h2 id="lp-notes" className="lp-h2 mt-4">
                  <Headline i18nKey="landing.notes.title" />
                </h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link to="/updates" className={buttonVariants({ variant: "outline", size: "sm" })}>{t("landing.notes.allUpdates")}</Link>
                <Link to="/docs" className={buttonVariants({ variant: "outline", size: "sm" })}>{t("landing.notes.allDocs")}</Link>
              </div>
            </div>
            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {notes.map((n, i) => {
                const Thumb = n.kind === "update" ? NewspaperThumb : GuideThumb;
                return (
                  <Link key={`${n.kind}-${n.title}`} to={n.href} className="group flex flex-col rounded-[18px] border border-line p-3 transition-colors hover:border-current">
                    <div className="lp-card flex aspect-[16/10] items-center justify-center rounded-[12px]" style={{ background: noteBg[i % noteBg.length] }}>
                      <Thumb className="w-3/4 transition-transform duration-300 group-hover:-translate-y-1" />
                    </div>
                    <div className="flex flex-1 flex-col px-2 pb-2 pt-4">
                      <p className="lp-tiny lp-muted">
                        {n.kind === "update" ? t("landing.notes.update") : t("landing.notes.doc")}
                        {n.date && <> · <time dateTime={n.date}>{n.date}</time></>}
                      </p>
                      <h3 className="lp-display mt-2 text-[18px] leading-snug">{n.title}</h3>
                      {n.desc && <p className="lp-muted mt-2 line-clamp-2 text-[15px]">{n.desc}</p>}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>

        {/* 6 · FAQ */}
        <section id="faq" className="scroll-mt-20 border-t border-line py-20 md:py-28">
          <div className="mx-auto max-w-3xl px-5">
            <h2 className="lp-h2 text-center">{t("landing.faq.title")}</h2>
            <div className="mt-12 border-b border-line">
              {FAQ.map((key) => (
                <details key={key} className="lp-faq border-t border-line">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-left">
                    <span className="lp-display text-[18px] md:text-[20px]">{t(`landing.faq.${key}.q`)}</span>
                    <Plus size={18} strokeWidth={1.4} className="lp-faq-plus shrink-0 transition-transform" aria-hidden />
                  </summary>
                  <p className="lp-muted pb-6 pr-8 text-[16.5px]">{t(`landing.faq.${key}.a`)}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* 7 · Open-source banner */}
        <section className="px-3 pb-16 md:px-6 md:pb-24">
          <div className="lp-banner relative mx-auto max-w-[1320px] overflow-hidden rounded-[28px] px-6 py-20 text-center md:py-28">
            <BannerPattern className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.16]" />
            <div className="relative mx-auto max-w-3xl">
              <p className="lp-eyebrow opacity-75">{t("landing.banner.eyebrow")}</p>
              <h2 className="lp-h2 mt-6">
                <Headline i18nKey="landing.banner.headline" />
              </h2>
              <p className="mx-auto mt-6 max-w-xl text-[17px] opacity-80">{t("landing.banner.desc")}</p>
              <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <a href={GITHUB_URL} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "inverse", size: "lg" })}>
                  {t("landing.cta.star")}
                </a>
                <Link
                  to="/pricing"
                  className={cn(buttonVariants({ variant: "outline", size: "lg" }), "border-banner-foreground/35 hover:border-banner-foreground")}
                >
                  {t("landing.pricing.cta")}
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
