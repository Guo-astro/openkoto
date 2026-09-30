import "@fontsource/cutive/latin-400.css";
import "@fontsource/newsreader/latin-400.css";
import "@fontsource/newsreader/latin-500.css";
import "@fontsource/newsreader/latin-400-italic.css";
import "../components/landing/landing.css";

import { ArrowUpRight, Globe, Monitor, Plus, Smartphone, Terminal } from "lucide-react";
import { useEffect, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Headline, LandingFooter, LandingHeader } from "../components/landing/LandingChrome";
import {
  BannerPattern,
  DevicesIllustration,
  FlashcardsIllustration,
  ForgettingCurveIllustration,
  GuideThumb,
  HeadphonesIllustration,
  HeroIllustration,
  LrcTimelineIllustration,
  MicrophoneIllustration,
  NewspaperThumb,
  OpenBookIllustration,
  ReaderIllustration,
  SyncIllustration,
  TerminalIllustration,
} from "../components/landing/illustrations";
import { contentLang, listDocs, listUpdates } from "../lib/content";
import { APP_STORE_URL, GITHUB_URL, RELEASES_URL, SKILL_URL } from "../lib/links";

type Illo = ComponentType<{ className?: string }>;

const FOCUS: { key: string; bg: string; Illo: Illo }[] = [
  { key: "review", bg: "var(--lp-mustard)", Illo: FlashcardsIllustration },
  { key: "novels", bg: "var(--lp-lavender)", Illo: OpenBookIllustration },
  { key: "lyrics", bg: "var(--lp-blue)", Illo: MicrophoneIllustration },
  { key: "sync", bg: "var(--lp-mint)", Illo: DevicesIllustration },
];

/** Showcase rows: name card colour, detail drawing, where "Learn more" goes. */
const SHOWCASE: { key: string; descKey: string; bg: string; Illo: Illo; href: string }[] = [
  { key: "review", descKey: "landing.features.review.desc", bg: "var(--lp-mustard)", Illo: ForgettingCurveIllustration, href: "/docs" },
  { key: "novels", descKey: "landing.features.novels.desc", bg: "var(--lp-lavender)", Illo: ReaderIllustration, href: "/docs" },
  { key: "lyrics", descKey: "landing.features.lyrics.desc", bg: "var(--lp-blue)", Illo: LrcTimelineIllustration, href: "/docs" },
  { key: "agents", descKey: "landing.features.agents.desc", bg: "var(--lp-mint)", Illo: TerminalIllustration, href: SKILL_URL },
  { key: "sync", descKey: "landing.features.sync.desc", bg: "var(--lp-sky-strong)", Illo: SyncIllustration, href: "#download" },
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

export function LandingPage() {
  const { t, i18n } = useTranslation();
  const lang = contentLang(i18n.language);

  useEffect(() => {
    document.title = `OpenKoto — ${t("landing.meta.title")}`;
  }, [t]);

  const notes = [
    ...listUpdates(lang)
      .slice(0, 2)
      .map((d) => ({ kind: "update" as const, href: "/updates", title: d.title, desc: d.description, date: d.date })),
    ...listDocs(lang)
      .slice(0, 2)
      .map((d) => ({ kind: "doc" as const, href: d.slug === "index" ? "/docs" : `/docs/${d.slug}`, title: d.title, desc: d.description, date: undefined })),
  ];
  const noteBg = ["var(--lp-sky-strong)", "var(--lp-mustard-soft)", "var(--lp-lavender)", "var(--lp-mint)"];

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
        {/* 1 · Hero */}
        <section className={`${container} pt-14 pb-10 text-center md:pt-24`}>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="lp-tiny lp-muted inline-flex items-center gap-1.5 rounded-full border border-[var(--lp-line)] px-3.5 py-1.5 hover:text-[var(--lp-ink)]"
          >
            {t("landing.hero.badge")} · Apache-2.0 <ArrowUpRight size={12} aria-hidden />
          </a>
          <h1 className="lp-h1 mx-auto mt-8 max-w-[1180px]">
            <Headline i18nKey="landing.hero.headline" />
          </h1>
          <p className="lp-muted mx-auto mt-7 max-w-xl text-[18px] md:text-[19px]">{t("landing.hero.subtitle")}</p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link to="/login" className="lp-pill">
              {t("landing.hero.start")}
            </Link>
            <a href="#download" className="lp-pill lp-pill-outline">
              {t("landing.hero.download")}
            </a>
          </div>
          <p className="lp-muted mt-5 text-[15px]">{t("landing.hero.note")}</p>
          <HeroIllustration className="lp-float mx-auto mt-10 w-full max-w-[680px] md:mt-6" />
        </section>

        {/* 2 · Sky band */}
        <section className="bg-[var(--lp-sky)] py-20 md:py-28">
          <div className={`${container} text-center`}>
            <h2 className="lp-h2 mx-auto max-w-4xl">
              <Headline i18nKey="landing.band.headline" />
            </h2>
            <p className="lp-muted mx-auto mt-6 max-w-2xl text-[18px]">{t("landing.band.body")}</p>
            <a href="#features" className="lp-pill mt-9">
              {t("landing.band.cta")}
            </a>
            <HeadphonesIllustration className="mx-auto mt-12 w-full max-w-[560px]" />
          </div>
        </section>

        {/* 3 · Focus */}
        <section id="features" className={`${container} scroll-mt-20 py-20 md:py-28`}>
          <p className="lp-eyebrow lp-muted text-center">{t("landing.focus.eyebrow")}</p>
          <p className="lp-display mx-auto mt-6 max-w-3xl text-center text-[22px] leading-[1.55] md:text-[28px]">{t("landing.focus.statement")}</p>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {FOCUS.map(({ key, bg, Illo }) => (
              <article key={key} className="lp-card flex flex-col rounded-[18px] p-6" style={{ background: bg }}>
                <Illo className="mx-auto aspect-[11/8] w-full max-w-[240px]" />
                <h3 className="lp-display mt-5 text-[21px] leading-tight">{t(`landing.focus.cards.${key}.title`)}</h3>
                <p className="mt-2 text-[15.5px] leading-relaxed opacity-80">{t(`landing.focus.cards.${key}.desc`)}</p>
              </article>
            ))}
          </div>
        </section>

        {/* 4 · Showcase list on a beige panel */}
        <section className="px-3 md:px-6" aria-labelledby="lp-showcase">
          <div className="mx-auto max-w-[1320px] rounded-[28px] bg-[var(--lp-beige)] px-5 py-16 md:px-14 md:py-24">
            <div className="mx-auto max-w-[1140px]">
              <p className="lp-eyebrow lp-muted text-center">{t("landing.showcase.eyebrow")}</p>
              <h2 id="lp-showcase" className="lp-h2 mx-auto mt-5 max-w-3xl text-center">
                <Headline i18nKey="landing.showcase.title" />
              </h2>
              <ol className="mt-14 space-y-14 md:mt-20 md:space-y-20">
                {SHOWCASE.map(({ key, descKey, bg, Illo, href }, i) => (
                  <li key={key}>
                    <div className="mb-4 flex items-baseline gap-4 border-t border-[var(--lp-line)] pt-4">
                      <span className="lp-tiny lp-muted">{String(i + 1).padStart(2, "0")}</span>
                      <h3 className="lp-tiny">{t(`landing.showcase.rows.${key}.label`)}</h3>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="lp-card flex min-h-[200px] items-end rounded-[18px] p-6 md:min-h-[280px] md:p-9" style={{ background: bg }}>
                        <p className="lp-display text-[26px] leading-[1.25] md:text-[34px]">{t(`landing.showcase.rows.${key}.name`)}</p>
                      </div>
                      <div className="lp-dark-card flex min-h-[200px] items-center justify-center rounded-[18px] p-6 md:min-h-[280px]">
                        <Illo className="w-full max-w-[400px]" />
                      </div>
                    </div>
                    <div className="mt-5 flex flex-col gap-4 md:flex-row md:items-start md:justify-between md:gap-10">
                      <p className="lp-muted max-w-2xl text-[16.5px]">{t(descKey)}</p>
                      <SmartLink href={href} className="lp-pill lp-pill-outline lp-pill-sm self-start">
                        {t("landing.showcase.learnMore")}
                        <span className="sr-only"> — {t(`landing.showcase.rows.${key}.label`)}</span>
                      </SmartLink>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* 5 · Download */}
        <section id="download" className={`${container} scroll-mt-20 py-20 md:py-28`}>
          <p className="lp-eyebrow lp-muted text-center">{t("landing.download.eyebrow")}</p>
          <h2 className="lp-h2 mx-auto mt-5 max-w-3xl text-center">
            <Headline i18nKey="landing.download.headline" />
          </h2>
          <p className="lp-muted mx-auto mt-5 max-w-xl text-center text-[17px]">{t("landing.download.subtitle")}</p>
          <ul className="mt-14 grid gap-px overflow-hidden rounded-[18px] border border-[var(--lp-line)] bg-[var(--lp-line)] sm:grid-cols-2 lg:grid-cols-4">
            {platforms.map(({ key, Icon, href }) => (
              <li key={key} className="flex flex-col bg-[var(--lp-bg)] p-7">
                <Icon size={26} strokeWidth={1.3} aria-hidden />
                <h3 className="lp-display mt-5 text-[20px]">{t(`landing.download.${key}.title`)}</h3>
                <p className="lp-muted mt-2 flex-1 text-[15.5px]">{t(`landing.download.${key}.desc`)}</p>
                <SmartLink href={href} className="lp-pill lp-pill-outline lp-pill-sm mt-6 self-start">
                  {t(`landing.download.${key}.cta`)}
                </SmartLink>
              </li>
            ))}
          </ul>
          <div className="lp-dark-card mx-auto mt-8 max-w-xl rounded-[18px] p-6">
            <p className="text-[15px] opacity-75">{t("landing.download.cliHint")}</p>
            <pre className="mt-3 overflow-x-auto font-mono text-[14px] leading-relaxed">
              <span className="opacity-50">$ </span>npm i -g @openkoto/cli{"\n"}
              <span className="opacity-50">$ </span>koto login
            </pre>
          </div>
        </section>

        {/* 6 · Updates & docs */}
        <section className="border-t border-[var(--lp-line)] py-20 md:py-28" aria-labelledby="lp-notes">
          <div className={container}>
            <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
              <div>
                <p className="lp-eyebrow lp-muted">{t("landing.notes.eyebrow")}</p>
                <h2 id="lp-notes" className="lp-h2 mt-4">
                  <Headline i18nKey="landing.notes.title" />
                </h2>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link to="/updates" className="lp-pill lp-pill-outline lp-pill-sm">{t("landing.notes.allUpdates")}</Link>
                <Link to="/docs" className="lp-pill lp-pill-outline lp-pill-sm">{t("landing.notes.allDocs")}</Link>
              </div>
            </div>
            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {notes.map((n, i) => {
                const Thumb = n.kind === "update" ? NewspaperThumb : GuideThumb;
                return (
                  <Link key={`${n.kind}-${n.title}`} to={n.href} className="group flex flex-col rounded-[18px] border border-[var(--lp-line)] p-3 transition-colors hover:border-current">
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

        {/* 7 · FAQ */}
        <section id="faq" className="scroll-mt-20 border-t border-[var(--lp-line)] py-20 md:py-28">
          <div className="mx-auto max-w-3xl px-5">
            <h2 className="lp-h2 text-center">{t("landing.faq.title")}</h2>
            <div className="mt-12 border-b border-[var(--lp-line)]">
              {FAQ.map((key) => (
                <details key={key} className="lp-faq border-t border-[var(--lp-line)]">
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

        {/* 8 · Dark warm banner */}
        <section className="px-3 pb-16 md:px-6 md:pb-24">
          <div className="lp-banner relative mx-auto max-w-[1320px] overflow-hidden rounded-[28px] px-6 py-20 text-center md:py-28">
            <BannerPattern className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.16]" />
            <div className="relative mx-auto max-w-3xl">
              <p className="lp-eyebrow opacity-75">{t("landing.banner.eyebrow")}</p>
              <h2 className="lp-h2 mt-6">
                <Headline i18nKey="landing.banner.headline" />
              </h2>
              <p className="mx-auto mt-6 max-w-xl text-[17px] opacity-85">{t("landing.banner.desc")}</p>
              <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="lp-pill">
                  {t("landing.cta.star")}
                </a>
                <Link to="/pricing" className="lp-pill lp-pill-outline">
                  {t("landing.pricing.cta")}
                </Link>
              </div>
              <p className="mx-auto mt-6 max-w-lg text-[14.5px] opacity-70">{t("landing.pricing.desc")}</p>
            </div>
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
