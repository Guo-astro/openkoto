import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useParams } from "react-router";
import { Markdown } from "../components/Markdown";
import { PublicLayout } from "../components/PublicLayout";
import { contentLang, getDoc, listDocs } from "../lib/content";
import { cn } from "../lib/utils";
import { NotFoundContent } from "./NotFoundPage";

export function DocsPage() {
  const { t, i18n } = useTranslation();
  const { slug = "index" } = useParams();
  const lang = contentLang(i18n.language);
  const doc = getDoc(slug, lang);
  const nav = listDocs(lang);

  useEffect(() => {
    if (doc) document.title = `${doc.title} · ${t("public.nav.docs")} · OpenKoto`;
    window.scrollTo(0, 0);
  }, [doc, t]);

  return (
    <PublicLayout>
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 md:flex-row md:py-12">
        <aside className="md:w-56 md:shrink-0">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("public.nav.docs")}</p>
          <nav className="flex gap-1 overflow-x-auto pb-2 md:flex-col md:overflow-visible md:pb-0 md:sticky md:top-20">
            {nav.map((d) => (
              <NavLink
                key={d.slug}
                to={d.slug === "index" ? "/docs" : `/docs/${d.slug}`}
                end
                className={({ isActive }) =>
                  cn(
                    "shrink-0 rounded-md px-3 py-1.5 text-sm transition-colors",
                    isActive ? "bg-accent text-accent-foreground font-medium" : "text-muted-foreground hover:text-foreground",
                  )
                }
              >
                {d.title}
              </NavLink>
            ))}
          </nav>
        </aside>
        <article className="min-w-0 flex-1 md:max-w-3xl">
          {doc ? (
            <>
              <h1 className="text-3xl font-semibold tracking-tight">{doc.title}</h1>
              {doc.description && <p className="mt-2 text-muted-foreground">{doc.description}</p>}
              <Markdown className="mt-8">{doc.body}</Markdown>
              {slug !== "index" && (
                <p className="mt-10 border-t border-border pt-6 text-sm">
                  <Link to="/docs" className="text-primary hover:underline">← {t("docs.back")}</Link>
                </p>
              )}
            </>
          ) : (
            <NotFoundContent />
          )}
        </article>
      </div>
    </PublicLayout>
  );
}
