import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, useParams } from "react-router";
import { LandingShell } from "../components/landing/LandingChrome";
import { Markdown } from "../components/Markdown";
import { buttonVariants } from "../components/ui/button";
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
    <LandingShell>
      <div className="mx-auto flex max-w-[1240px] flex-col gap-10 px-5 py-10 md:flex-row md:px-10 md:py-16">
        <aside className="md:w-60 md:shrink-0">
          <p className="lp-eyebrow lp-muted mb-4 px-1">{t("public.nav.docs")}</p>
          <nav className="flex gap-1 overflow-x-auto pb-2 md:flex-col md:overflow-visible md:pb-0 md:sticky md:top-24">
            {nav.map((d) => (
              <NavLink
                key={d.slug}
                to={d.slug === "index" ? "/docs" : `/docs/${d.slug}`}
                end
                className={({ isActive }) =>
                  cn(
                    "shrink-0 rounded-full px-3.5 py-1.5 text-[15px] transition-colors",
                    isActive ? "bg-honey-soft text-foreground" : "lp-muted hover:bg-line hover:text-foreground",
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
              <h1 className="lp-h2">{doc.title}</h1>
              {doc.description && <p className="lp-muted mt-4 text-[17px]">{doc.description}</p>}
              <Markdown className="mt-10 border-t border-line pt-8">{doc.body}</Markdown>
              {slug !== "index" && (
                <p className="mt-12 border-t border-line pt-6">
                  <Link to="/docs" className={buttonVariants({ variant: "outline", size: "sm" })}>← {t("docs.back")}</Link>
                </p>
              )}
            </>
          ) : (
            <NotFoundContent />
          )}
        </article>
      </div>
    </LandingShell>
  );
}
