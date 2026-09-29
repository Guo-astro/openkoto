import { ArrowRight, BookOpen, Brain, ChevronDown, Download, Globe, KeyRound, Monitor, Music, RefreshCw, Smartphone, Terminal } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { GithubIcon, linkButton, PublicLayout } from "../components/PublicLayout";
import { APP_STORE_URL, GITHUB_URL, RELEASES_URL, SKILL_URL } from "../lib/links";

const FEATURES = [
  { key: "review", icon: Brain },
  { key: "novels", icon: BookOpen },
  { key: "lyrics", icon: Music },
  { key: "sync", icon: RefreshCw },
  { key: "agents", icon: Terminal },
  { key: "open", icon: KeyRound },
] as const;

const FAQ = ["what", "free", "platforms", "privacy", "ai", "agents"] as const;

function SectionTitle({ eyebrow, title, subtitle }: { eyebrow?: string; title: string; subtitle?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center space-y-3">
      {eyebrow && <p className="text-sm font-medium text-primary">{eyebrow}</p>}
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
      {subtitle && <p className="text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

/** A small illustrative collage of the three study modes (no screenshots to keep it light). */
function HeroPreview() {
  const { t } = useTranslation();
  return (
    <div className="relative mx-auto w-full max-w-md" aria-hidden>
      <div className="absolute -inset-2 sm:-inset-6 -z-10 rounded-[2rem] bg-gradient-to-br from-primary/15 via-transparent to-primary/5 blur-2xl" />
      <div className="space-y-3">
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><Brain size={14} /> {t("landing.preview.review")}</span>
            <span>FSRS</span>
          </div>
          <p className="mt-3 text-center text-3xl font-semibold">言葉</p>
          <p className="text-center text-sm text-muted-foreground">ことば · {t("landing.preview.word")}</p>
          <div className="mt-4 grid grid-cols-4 gap-1.5 text-center text-xs">
            {(["again", "hard", "good", "easy"] as const).map((g) => (
              <span key={g} className={`rounded-md border border-border py-1.5 ${g === "good" ? "bg-primary text-primary-foreground border-primary" : "bg-background"}`}>
                {t(`review.${g}`)}
              </span>
            ))}
          </div>
        </div>
        <div className="ml-6 rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><BookOpen size={14} /> {t("landing.preview.novel")}</div>
          <p className="mt-2 text-sm leading-relaxed">{t("landing.preview.novelSource")}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t("landing.preview.translation")}</p>
        </div>
        <div className="mr-6 rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground"><Music size={14} /> {t("landing.preview.lyrics")}</div>
          <div className="mt-2 space-y-1 text-sm">
            <p className="text-muted-foreground"><span className="font-mono text-xs mr-2">[00:12]</span>夜空に光る星のように</p>
            <p className="font-medium text-primary"><span className="font-mono text-xs mr-2">[00:16]</span>君の声が聞こえる</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function LandingPage() {
  const { t } = useTranslation();

  useEffect(() => {
    document.title = `OpenKoto — ${t("landing.hero.title")}${t("landing.hero.highlight")}`;
  }, [t]);

  const platforms = [
    { key: "web", icon: Globe, href: "/login", internal: true },
    { key: "ios", icon: Smartphone, href: APP_STORE_URL },
    { key: "desktop", icon: Monitor, href: RELEASES_URL },
    { key: "cli", icon: Terminal, href: SKILL_URL },
  ] as const;

  return (
    <PublicLayout>
      {/* Hero */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-12 pb-16 md:grid-cols-2 md:pt-20 md:pb-24">
        <div className="space-y-6 text-center md:text-left">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <GithubIcon size={13} /> {t("landing.hero.badge")} <ArrowRight size={12} aria-hidden />
          </a>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            {t("landing.hero.title")}
            <span className="inline-block text-primary">{t("landing.hero.highlight")}</span>
          </h1>
          <p className="text-lg text-muted-foreground">{t("landing.hero.subtitle")}</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-center md:justify-start">
            <Link to="/login" className={linkButton("default", "lg")}>
              {t("landing.hero.start")} <ArrowRight size={18} aria-hidden />
            </Link>
            <a href="#download" className={linkButton("outline", "lg")}>
              <Download size={18} aria-hidden /> {t("landing.hero.download")}
            </a>
          </div>
          <p className="text-sm text-muted-foreground">{t("landing.hero.note")}</p>
        </div>
        <HeroPreview />
      </section>

      {/* Features */}
      <section id="features" className="scroll-mt-16 border-t border-border bg-muted/30 py-16 md:py-24">
        <div className="mx-auto max-w-6xl px-4 space-y-12">
          <SectionTitle eyebrow={t("landing.features.eyebrow")} title={t("landing.features.title")} subtitle={t("landing.features.subtitle")} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ key, icon: Icon }) => (
              <div key={key} className="rounded-xl border border-border bg-card p-6">
                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon size={20} aria-hidden />
                </div>
                <h3 className="font-semibold">{t(`landing.features.${key}.title`)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{t(`landing.features.${key}.desc`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Download */}
      <section id="download" className="scroll-mt-16 py-16 md:py-24">
        <div className="mx-auto max-w-6xl px-4 space-y-12">
          <SectionTitle eyebrow={t("landing.download.eyebrow")} title={t("landing.download.title")} subtitle={t("landing.download.subtitle")} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {platforms.map(({ key, icon: Icon, href, ...rest }) => {
              const internal = "internal" in rest;
              const content = (
                <>
                  <Icon size={22} className="text-primary" aria-hidden />
                  <h3 className="mt-3 font-semibold">{t(`landing.download.${key}.title`)}</h3>
                  <p className="mt-1 flex-1 text-sm text-muted-foreground">{t(`landing.download.${key}.desc`)}</p>
                  <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary">
                    {t(`landing.download.${key}.cta`)} <ArrowRight size={14} aria-hidden />
                  </span>
                </>
              );
              const cls = "flex flex-col rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/50";
              return internal ? (
                <Link key={key} to={href} className={cls}>{content}</Link>
              ) : (
                <a key={key} href={href} target="_blank" rel="noreferrer" className={cls}>{content}</a>
              );
            })}
          </div>
          <div className="mx-auto max-w-xl rounded-xl border border-border bg-muted/40 p-4">
            <p className="text-sm text-muted-foreground">{t("landing.download.cliHint")}</p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-background p-3 text-sm font-mono border border-border">npm i -g @openkoto/cli{"\n"}koto login</pre>
          </div>
        </div>
      </section>

      {/* Pricing teaser */}
      <section className="border-t border-border bg-muted/30 py-16">
        <div className="mx-auto flex max-w-4xl flex-col items-center gap-6 px-4 text-center md:flex-row md:text-left">
          <div className="flex-1 space-y-2">
            <h2 className="text-2xl font-semibold tracking-tight">{t("landing.pricing.title")}</h2>
            <p className="text-muted-foreground">{t("landing.pricing.desc")}</p>
          </div>
          <Link to="/pricing" className={linkButton("outline", "lg")}>
            {t("landing.pricing.cta")} <ArrowRight size={18} aria-hidden />
          </Link>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="scroll-mt-16 py-16 md:py-24">
        <div className="mx-auto max-w-3xl px-4 space-y-10">
          <SectionTitle title={t("landing.faq.title")} />
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            {FAQ.map((key) => (
              <details key={key} className="group p-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium [&::-webkit-details-marker]:hidden">
                  {t(`landing.faq.${key}.q`)}
                  <ChevronDown size={18} className="shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t(`landing.faq.${key}.a`)}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-border py-16 md:py-20">
        <div className="mx-auto max-w-2xl space-y-6 px-4 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t("landing.cta.title")}</h2>
          <p className="text-muted-foreground">{t("landing.cta.desc")}</p>
          <div className="flex flex-col justify-center gap-3 sm:flex-row">
            <Link to="/login" className={linkButton("default", "lg")}>
              {t("landing.hero.start")} <ArrowRight size={18} aria-hidden />
            </Link>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className={linkButton("outline", "lg")}>
              <GithubIcon size={18} /> {t("landing.cta.star")}
            </a>
          </div>
        </div>
      </section>
    </PublicLayout>
  );
}
