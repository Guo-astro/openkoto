import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { BrowserRouter, Route, Routes } from "react-router";
import { AppLayout, RequireAuth } from "./components/Layout";
import { LibraryProvider } from "./lib/library";
import { SessionProvider } from "./lib/session";
import { AccountPage } from "./pages/AccountPage";
import { DevicePage } from "./pages/DevicePage";
import { HomePage } from "./pages/HomePage";
import { LegalPage } from "./pages/LegalPage";
import { LoginPage } from "./pages/LoginPage";
import { PricingPage } from "./pages/PricingPage";
import { ReviewPage } from "./pages/ReviewPage";
import { VocabPage } from "./pages/VocabPage";

// Reading pages pull in the EPUB renderer; load them on demand.
const LibraryPage = lazy(() => import("./pages/LibraryPage").then((m) => ({ default: m.LibraryPage })));
const ReaderPage = lazy(() => import("./pages/ReaderPage").then((m) => ({ default: m.ReaderPage })));
const LyricsListPage = lazy(() => import("./pages/LyricsPage").then((m) => ({ default: m.LyricsListPage })));
const LyricsDetailPage = lazy(() => import("./pages/LyricsPage").then((m) => ({ default: m.LyricsDetailPage })));

function Loading() {
  const { t } = useTranslation();
  return <p className="text-muted-foreground">{t("common.loading")}</p>;
}

export function App() {
  return (
    <SessionProvider>
      <LibraryProvider>
        <BrowserRouter>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/privacy" element={<LegalPage kind="privacy" />} />
              <Route path="/terms" element={<LegalPage kind="terms" />} />
              <Route element={<AppLayout />}>
                <Route path="/pricing" element={<PricingPage />} />
                <Route element={<RequireAuth />}>
                  <Route index element={<HomePage />} />
                  <Route path="/review" element={<ReviewPage />} />
                  <Route path="/vocab" element={<VocabPage />} />
                  <Route path="/library" element={<LibraryPage />} />
                  <Route path="/read/:bookId" element={<ReaderPage />} />
                  <Route path="/lyrics" element={<LyricsListPage />} />
                  <Route path="/lyrics/:id" element={<LyricsDetailPage />} />
                  <Route path="/account" element={<AccountPage />} />
                  <Route path="/device" element={<DevicePage />} />
                </Route>
              </Route>
            </Routes>
          </Suspense>
        </BrowserRouter>
      </LibraryProvider>
    </SessionProvider>
  );
}
