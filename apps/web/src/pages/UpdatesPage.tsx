import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "../components/Markdown";
import { PublicLayout } from "../components/PublicLayout";
import { contentLang, listUpdates } from "../lib/content";

export function UpdatesPage() {
  const { t, i18n } = useTranslation();
  const lang = contentLang(i18n.language);
  const entries = listUpdates(lang);

  useEffect(() => {
    document.title = `${t("updates.title")} · OpenKoto`;
  }, [t]);

  return (
    <PublicLayout>
      <div className="mx-auto max-w-3xl px-4 py-10 md:py-14">
        <h1 className="text-3xl font-semibold tracking-tight">{t("updates.title")}</h1>
        <p className="mt-2 text-muted-foreground">{t("updates.subtitle")}</p>
        <ol className="mt-10 space-y-12">
          {entries.map((e) => (
            <li key={e.slug} className="relative border-l-2 border-border pl-6">
              <span className="absolute -left-[7px] top-1.5 h-3 w-3 rounded-full bg-primary" aria-hidden />
              {e.date && (
                <time dateTime={e.date} className="text-sm text-muted-foreground">
                  {new Date(`${e.date}T00:00:00`).toLocaleDateString(i18n.language, { year: "numeric", month: "long", day: "numeric" })}
                </time>
              )}
              <h2 className="mt-1 text-xl font-semibold">{e.title}</h2>
              {e.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {e.tags.map((tag) => (
                    <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              <Markdown className="mt-4">{e.body}</Markdown>
            </li>
          ))}
        </ol>
      </div>
    </PublicLayout>
  );
}
