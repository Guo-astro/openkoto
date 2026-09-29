import { useEffect } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { setLanguage } from "../i18n";
import { NotFoundPage } from "./NotFoundPage";

// The old marketing site (Next.js) used `/:lang/...` URLs and long legal slugs. Existing app builds and
// App Store metadata still link to them. The Worker answers with 301s; this is the client-side fallback.

export const LEGACY_LANGS = ["en", "zh", "ja"] as const;

function isLegacyLang(lang: string | undefined): lang is (typeof LEGACY_LANGS)[number] {
  return !!lang && (LEGACY_LANGS as readonly string[]).includes(lang);
}

/**
 * Redirects `/:lang/<rest>` to `to` (or `/<rest>` when omitted), switching the UI language to `:lang`.
 * Unknown `:lang` values render the 404 page.
 */
export function LegacyLangRedirect({ to }: { to?: string }) {
  const { lang, "*": rest } = useParams();
  const location = useLocation();
  const valid = isLegacyLang(lang);

  useEffect(() => {
    if (isLegacyLang(lang)) setLanguage(lang);
  }, [lang]);

  if (!valid) return <NotFoundPage />;
  const target = to ?? `/${rest ?? ""}`;
  return <Navigate to={`${target}${location.search}${location.hash}`} replace />;
}
