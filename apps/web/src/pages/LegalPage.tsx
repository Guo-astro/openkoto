import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "../components/Markdown";
import { PublicLayout } from "../components/PublicLayout";
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
    <PublicLayout>
      <div className="mx-auto max-w-3xl px-4 py-10 md:py-14">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("legal.updated", { date: UPDATED })}</p>
        {doc && <Markdown className="mt-8">{doc.body}</Markdown>}
      </div>
    </PublicLayout>
  );
}
