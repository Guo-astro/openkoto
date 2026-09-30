import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LandingShell } from "../components/landing/LandingChrome";
import { Markdown } from "../components/Markdown";
import { contentLang, getLegal } from "../lib/content";

// Plain-language policies for the OpenKoto apps and cloud service; the iOS/desktop apps link here too.
// Sources: src/content/legal/{privacy,terms}.{en,zh,ja}.md
const UPDATED = "2026-09-29";

export function LegalPage({ kind }: { kind: "privacy" | "terms" }) {
  const { t, i18n } = useTranslation();
  const doc = getLegal(kind, contentLang(i18n.language));
  const title = kind === "privacy" ? t("footer.privacy") : t("footer.terms");

  useEffect(() => {
    document.title = `${title} · OpenKoto`;
  }, [title]);

  return (
    <LandingShell>
      <div className="mx-auto max-w-3xl px-5 py-14 md:py-20">
        <p className="lp-eyebrow lp-muted">{t("public.footer.legal")}</p>
        <h1 className="lp-h2 mt-4">{title}</h1>
        <p className="lp-muted mt-3 text-[15px]">{t("legal.updated", { date: UPDATED })}</p>
        {doc && <Markdown className="mt-10 border-t border-[var(--lp-line)] pt-8">{doc.body}</Markdown>}
      </div>
    </LandingShell>
  );
}
