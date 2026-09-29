import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppLayout, RequireAuth } from "./components/Layout";
import { LibraryProvider } from "./lib/library";
import { SessionProvider, useSession } from "./lib/session";
import { AccountPage } from "./pages/AccountPage";
import { AssistantPage } from "./pages/AssistantPage";
import { AuthorizeAppPage } from "./pages/AuthorizeAppPage";
import { DevicePage } from "./pages/DevicePage";
import { HomePage } from "./pages/HomePage";
import { LandingPage } from "./pages/LandingPage";
import { LegacyLangRedirect } from "./pages/LegacyRedirects";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OAuthConsentPage } from "./pages/OAuthConsentPage";
import { PricingPage } from "./pages/PricingPage";
import { ReviewPage } from "./pages/ReviewPage";
import { VocabPage } from "./pages/VocabPage";

// Reading pages pull in the EPUB renderer; load them on demand.
const LibraryPage = lazy(() => import("./pages/LibraryPage").then((m) => ({ default: m.LibraryPage })));
const ReaderPage = lazy(() => import("./pages/ReaderPage").then((m) => ({ default: m.ReaderPage })));
const LyricsListPage = lazy(() => import("./pages/LyricsPage").then((m) => ({ default: m.LyricsListPage })));
const LyricsDetailPage = lazy(() => import("./pages/LyricsPage").then((m) => ({ default: m.LyricsDetailPage })));
// Docs, changelog and legal pages carry the markdown renderer and bundled content.
const DocsPage = lazy(() => import("./pages/DocsPage").then((m) => ({ default: m.DocsPage })));
const UpdatesPage = lazy(() => import("./pages/UpdatesPage").then((m) => ({ default: m.UpdatesPage })));
const LegalPage = lazy(() => import("./pages/LegalPage").then((m) => ({ default: m.LegalPage })));

function Loading() {
  const { t } = useTranslation();
  return <p className="text-muted-foreground">{t("common.loading")}</p>;
}

/** `/`: the dashboard when signed in, the public landing page otherwise. */
function RootPage() {
  const { account, loading } = useSession();
  const { t } = useTranslation();
  if (loading) return <div className="p-8 text-muted-foreground">{t("common.loading")}</div>;
  if (!account) return <LandingPage />;
  return (
    <AppLayout>
      <HomePage />
    </AppLayout>
  );
}

export function AppRoutes() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route index element={<RootPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/privacy" element={<LegalPage kind="privacy" />} />
        <Route path="/terms" element={<LegalPage kind="terms" />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/docs/:slug" element={<DocsPage />} />
        <Route path="/updates" element={<UpdatesPage />} />
        {/* Legacy marketing-site URLs (koto_intro_web). The Worker also 301s these. */}
        <Route path="/privacy-policy" element={<Navigate to="/privacy" replace />} />
        <Route path="/terms-of-service" element={<Navigate to="/terms" replace />} />
        <Route path="/:lang" element={<LegacyLangRedirect to="/" />} />
        <Route path="/:lang/privacy-policy" element={<LegacyLangRedirect to="/privacy" />} />
        <Route path="/:lang/terms-of-service" element={<LegacyLangRedirect to="/terms" />} />
        <Route path="/:lang/*" element={<LegacyLangRedirect />} />
        <Route element={<AppLayout />}>
          <Route path="/pricing" element={<PricingPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/vocab" element={<VocabPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/read/:bookId" element={<ReaderPage />} />
            <Route path="/lyrics" element={<LyricsListPage />} />
            <Route path="/lyrics/:id" element={<LyricsDetailPage />} />
            <Route path="/assistant" element={<AssistantPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/device" element={<DevicePage />} />
            <Route path="/authorize-app" element={<AuthorizeAppPage />} />
            <Route path="/oauth/consent" element={<OAuthConsentPage />} />
          </Route>
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <SessionProvider>
      <LibraryProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </LibraryProvider>
    </SessionProvider>
  );
}
