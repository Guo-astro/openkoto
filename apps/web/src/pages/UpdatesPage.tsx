import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LandingShell } from "../components/landing/LandingChrome";
import { Markdown } from "../components/Markdown";
import { contentLang, listUpdates } from "../lib/content";

const TAG_BG = ["var(--lp-mist)", "var(--lp-honey)", "var(--lp-clay)", "var(--lp-sage)"];

export function UpdatesPage() {
  const { t, i18n } = useTranslation();
  const lang = contentLang(i18n.language);
  const entries = listUpdates(lang);

  useEffect(() => {
    document.title = `${t("updates.title")} · OpenKoto`;
  }, [t]);

  return (
    <LandingShell>
      <div className="mx-auto max-w-3xl px-5 py-14 md:py-20">
        <p className="lp-eyebrow lp-muted">{t("public.nav.updates")}</p>
        <h1 className="lp-h2 mt-4">{t("updates.title")}</h1>
        <p className="lp-muted mt-4 text-[17px]">{t("updates.subtitle")}</p>
        <ol className="mt-14 space-y-14">
          {entries.map((e) => (
            <li key={e.slug} className="relative border-t border-line pt-6 md:grid md:grid-cols-[150px_1fr] md:gap-8">
              <div>
                {e.date && (
                  <time dateTime={e.date} className="lp-tiny lp-muted">
                    {new Date(`${e.date}T00:00:00`).toLocaleDateString(i18n.language, { year: "numeric", month: "short", day: "numeric" })}
                  </time>
                )}
              </div>
              <div className="min-w-0">
                <h2 className="mt-2 text-[26px] leading-tight md:mt-0">{e.title}</h2>
                {e.tags.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {e.tags.map((tag, i) => (
                      <span key={tag} className="lp-card rounded-full px-2.5 py-0.5 text-[13px]" style={{ background: TAG_BG[i % TAG_BG.length] }}>
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <Markdown className="mt-5">{e.body}</Markdown>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </LandingShell>
  );
}
