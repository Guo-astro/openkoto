import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { BookOpen, RotateCw, Star, LayoutGrid, List, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ArticleList } from "./components/features/ArticleList";
import { ArticleReader } from "./components/features/ArticleReader";
import { BookReader } from "./components/features/BookReader";
import { KtvExportPage } from "./components/features/KtvExportPage";
import { NewMaterialDialog } from "./components/features/NewMaterialDialog";
import { FavoritesPage } from "./components/features/FavoritesPage";
import { SettingsButton, SettingsDialog, type SettingsSectionKey } from "./components/features/SettingsDialog";
import { ApiQuickSwitcher } from "./components/features/ApiQuickSwitcher";
import { OnboardingDialog } from "./components/features/OnboardingDialog";
import { Button } from "./components/ui/button";
import { UpdateChecker } from "./components/features/UpdateChecker";
import { DropImportOverlay, type DropImportStatus } from "./components/features/DropImportOverlay";
import { importDroppedPath, isSupportedDropPath, getFileName } from "./lib/dropImport";
import type { Article, AppConfig } from "./lib/tauri";
import { useAgentOpenMaterialListener } from "./lib/hooks/useAgentOpenMaterialListener";
import { useCloudDataChanged } from "./lib/hooks/useCloudDataChanged";
import { migrateLegacyBookProgress } from "./lib/bookProgress";

function App() {
  const { t } = useTranslation();
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number>(-1);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showFavorites, setShowFavorites] = useState(false);
  const [editingArticle, setEditingArticle] = useState<Article | null>(null);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "card">("card");
  const [activeScreen, setActiveScreen] = useState<"home" | "favorites" | "reader" | "ktv-export">("home");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const onboardingDismissedRef = useRef(false);

  // 设置弹窗（上提到 App，便于从其他组件按指定分区打开）
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionKey>("models");
  const openSettings = (section: SettingsSectionKey = "models") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  // 拖放导入状态
  const [isDragging, setIsDragging] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importingCount, setImportingCount] = useState(0);
  const [dropStatus, setDropStatus] = useState<DropImportStatus | null>(null);
  const dropStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isImportingRef = useRef(false);

  // Load config and articles on mount
  useEffect(() => {
    loadData();
    // 一次性把旧的 localStorage 阅读进度迁入 book_progress(随后同步为 BookProgress)
    void migrateLegacyBookProgress();
  }, []);

  // 云同步应用了远端修改:刷新素材列表
  useCloudDataChanged(() => {
    void loadData();
  });

  // 全局拖放导入：把 PDF/EPUB/视频/音频/字幕 拖到窗口即导入（Tauri 原生事件）
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
    void getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          if (!isImportingRef.current) setIsDragging(true);
          return;
        }
        if (payload.type === "leave") {
          setIsDragging(false);
          return;
        }
        if (payload.type === "drop") {
          setIsDragging(false);
          if (isImportingRef.current) return;
          const paths = (payload.paths || []).filter(isSupportedDropPath);
          const unsupported = (payload.paths || []).filter((p) => !isSupportedDropPath(p));
          if (paths.length === 0) {
            setDropStatus({
              ok: 0,
              errors: [t("dropImport.unsupported", "不支持的文件类型: {{name}}", {
                name: unsupported.map(getFileName).join(", ") || "?",
              })],
            });
            scheduleStatusClear();
            return;
          }

          isImportingRef.current = true;
          setIsImporting(true);
          setImportingCount(paths.length);
          const imported: Article[] = [];
          const errors: string[] = [];
          for (const p of paths) {
            try {
              imported.push(await importDroppedPath(p));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              errors.push(
                msg.startsWith("unsupported:")
                  ? t("dropImport.unsupported", "不支持的文件类型: {{name}}", { name: msg.slice("unsupported:".length) })
                  : t("dropImport.failed", "导入失败: {{error}}", { error: msg }),
              );
            }
          }
          setIsImporting(false);
          isImportingRef.current = false;

          const fresh = await loadData();
          // 单个文件成功 → 自动打开（用刷新后的列表，避免闭包里的旧 state）
          if (imported.length === 1 && errors.length === 0) {
            const art = fresh.find((a) => a.id === imported[0].id) ?? imported[0];
            setSelectedIndex(fresh.findIndex((a) => a.id === art.id));
            setShowFavorites(false);
            setSelectedArticle(art);
            setActiveScreen("reader");
          }
          setDropStatus({ ok: imported.length, errors });
          scheduleStatusClear();
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    } catch {
      // 非 Tauri 环境（测试/浏览器）下拖放 API 不可用，忽略
    }
    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleStatusClear = () => {
    if (dropStatusTimer.current) clearTimeout(dropStatusTimer.current);
    dropStatusTimer.current = setTimeout(() => setDropStatus(null), 3500);
  };

  useAgentOpenMaterialListener((materialId) => {
    const existingArticle = articles.find((article) => article.id === materialId);
    if (existingArticle) {
      setShowFavorites(false);
      handleSelectArticle(existingArticle);
      return;
    }

    void invoke<Article>("get_article", { id: materialId })
      .then((article) => {
        setArticles((current) => {
          const nextArticles = current.some((item) => item.id === article.id)
            ? current
            : [article, ...current];
          setSelectedIndex(nextArticles.findIndex((item) => item.id === article.id));
          return nextArticles;
        });
        setSelectedArticle(article);
        setShowFavorites(false);
      })
      .catch((error) => {
        console.error("Failed to open material from agent event:", error);
      });
  });

  const loadData = async (): Promise<Article[]> => {
    setIsLoading(true);
    try {
      const [configResult, articlesResult] = await Promise.all([
        invoke<AppConfig | null>("get_config"),
        invoke<Article[]>("list_articles_cmd"),
      ]);
      setConfig(configResult);
      const hasSavedModelConfigs = !!configResult?.model_configs?.length;
      const shouldShowOnboarding =
        !onboardingDismissedRef.current &&
        (!configResult || (!configResult.onboarding_completed && !hasSavedModelConfigs));

      setShowOnboarding(shouldShowOnboarding);
      setArticles(articlesResult);
      return articlesResult;
    } catch (err) {
      console.error("Failed to load data:", err);
      return [];
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectArticle = (article: Article) => {
    const index = articles.findIndex((a) => a.id === article.id);
    setSelectedIndex(index);
    setSelectedArticle(article);
    setActiveScreen("reader");
  };

  const handleNextArticle = () => {
    if (selectedIndex < articles.length - 1) {
      handleSelectArticle(articles[selectedIndex + 1]);
    }
  };

  const handlePrevArticle = () => {
    if (selectedIndex > 0) {
      handleSelectArticle(articles[selectedIndex - 1]);
    }
  };

  const handleBackToList = () => {
    setSelectedArticle(null);
    setActiveScreen("home");
  };

  const handleGoHome = () => {
    setSelectedArticle(null);
    setShowFavorites(false);
    setActiveScreen("home");
  };

  const handleToggleFavorites = () => {
    setShowFavorites(true);
    setSelectedArticle(null);
    setActiveScreen("favorites");
  };

  const handleBackFromFavorites = () => {
    setShowFavorites(false);
    setActiveScreen("home");
  };

  const handleArticleUpdate = async () => {
    const refreshedArticles = await loadData();
    // 如果当前有选中的文章，用最新数据更新它
    if (selectedArticle) {
      const updatedArticle = refreshedArticles.find(a => a.id === selectedArticle.id);
      if (updatedArticle) {
        console.log("[App] Refreshed selectedArticle with", updatedArticle.segments?.length, "segments");
        setSelectedArticle(updatedArticle);
      }
    }
  };

  // 新建素材弹窗保存后：刷新列表；新导入的书籍素材直接打开，避免被误认为进入了精读
  const handleMaterialSaved = async (article: Article) => {
    const refreshedArticles = await loadData();
    if (!editingArticle && article.book_path) {
      const fresh = refreshedArticles.find(a => a.id === article.id) ?? article;
      setSelectedIndex(refreshedArticles.findIndex(a => a.id === fresh.id));
      setShowFavorites(false);
      setSelectedArticle(fresh);
      setActiveScreen("reader");
    }
  };

  const handleDeleteArticle = async (id: string) => {
    console.log("App: handleDeleteArticle called for id:", id);
    try {
      await invoke("delete_article_cmd", { id });
      console.log("App: Article deleted successfully via backend");
      await loadData(); // Reload to refresh list
    } catch (e) {
      console.error("App: Failed to delete article", e);
    }
  };

  const handleCreateMaterial = () => {
    setEditingArticle(null);
    setIsEditDialogOpen(true);
  };

  const handleEditArticle = (article: Article) => {
    setEditingArticle(article);
    setIsEditDialogOpen(true);
  };



  const hasConfig = config?.model_configs && config.model_configs.length > 0 && config.active_model_id;
  const selectedId: string | undefined = selectedArticle?.id;

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4" />
          <p className="text-muted-foreground">{t("app.loading")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background text-foreground">
      <DropImportOverlay
        isDragging={isDragging}
        isImporting={isImporting}
        importingCount={importingCount}
        status={dropStatus}
      />
      {/* Header */}
      {!selectedArticle && (
        <header className="flex items-center justify-between px-6 py-4 border-b border-border bg-card/50 backdrop-blur-sm supports-[backdrop-filter]:bg-card/50">
          <div className="flex items-center gap-3 cursor-pointer hover:opacity-80 transition-opacity" onClick={handleGoHome}>
            <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary text-primary-foreground">
              <BookOpen size={20} />
            </div>
            <div>
              <h1 className="text-lg font-semibold">{t("app.title")}</h1>
              <p className="text-xs text-muted-foreground">{t("app.subtitle")}</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {!hasConfig && (
              <div className="px-3 py-1.5 bg-yellow-500/10 border border-yellow-500/50 rounded-lg text-yellow-600 dark:text-yellow-400 text-sm">
                {t("header.configureApiKey")}
              </div>
            )}

            <Button
              variant={showFavorites ? "default" : "secondary"}
              onClick={handleToggleFavorites}
              className="gap-2"
            >
              <Star size={16} className={showFavorites ? "fill-current" : ""} />
              {t("header.favorites", "收藏夹")}
            </Button>

            <Button onClick={handleCreateMaterial} className="gap-2">
              <Plus size={16} />
              {t("header.newMaterial")}
            </Button>
            <SettingsButton onOpen={() => openSettings("models")} />
          </div>
        </header>
      )}

      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        <NewMaterialDialog
          isOpen={isEditDialogOpen}
          onClose={() => { setIsEditDialogOpen(false); setEditingArticle(null) }}
          onSave={handleMaterialSaved}
          editingArticle={editingArticle}
        />
        <OnboardingDialog
          isOpen={showOnboarding}
          onFinish={() => {
            onboardingDismissedRef.current = true;
            setShowOnboarding(false);
            loadData();
          }}
        />
        <UpdateChecker />
        <SettingsDialog
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSave={handleArticleUpdate}
          initialSection={settingsSection}
        />
        {selectedArticle ? (
          activeScreen === "ktv-export" ? (
            <KtvExportPage
              article={selectedArticle}
              onBack={() => setActiveScreen("reader")}
            />
          ) : selectedArticle.book_path ? (
            <BookReader
              article={selectedArticle}
              onBack={handleBackToList}
              onUpdate={handleArticleUpdate}
            />
          ) : (
            <ArticleReader
              article={selectedArticle}
              onBack={handleBackToList}
              onNext={handleNextArticle}
              onPrev={handlePrevArticle}
              hasNext={selectedIndex < articles.length - 1}
              hasPrev={selectedIndex > 0}
              onUpdate={handleArticleUpdate}
              onOpenKtvExport={() => setActiveScreen("ktv-export")}
              onOpenAsrSettings={() => openSettings("transcription")}
            />
          )
        ) : showFavorites || activeScreen === "favorites" ? (
          <FavoritesPage
            onBack={handleBackFromFavorites}
            onSelectArticle={handleSelectArticle}
          />
        ) : (
          <div className="h-full max-w-4xl mx-auto p-6 overflow-y-auto">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-semibold">{t("articleList.title").replace("我的文章", "我的素材")}</h2>
              <div className="flex items-center gap-2 bg-muted/50 p-1 rounded-lg border border-border">
                <Button
                  variant={viewMode === "list" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setViewMode("list")}
                  className="h-7 px-2"
                  title={t("articleList.listView")}
                >
                  <List size={14} />
                </Button>
                <Button
                  variant={viewMode === "card" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setViewMode("card")}
                  className="h-7 px-2"
                  title={t("articleList.cardView")}
                >
                  <LayoutGrid size={14} />
                </Button>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={loadData}
                  disabled={isLoading}
                  title={t("common.refresh")}
                >
                  <RotateCw size={16} className={isLoading ? "animate-spin" : ""} />
                </Button>
              </div>
            </div>
            <ArticleList
              articles={articles}
              isLoading={isLoading}
              onSelectArticle={handleSelectArticle}
              onDelete={handleDeleteArticle}
              onEdit={handleEditArticle}
              onNewMaterial={handleCreateMaterial}
              onUpdate={handleArticleUpdate}
              selectedId={selectedId}
              viewMode={viewMode}
            />
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="px-6 py-3 border-t border-border bg-card/50 text-xs text-muted-foreground">
        <div className="flex items-center justify-between">
          <p>OpenKoto v{__APP_VERSION__}</p>
          <ApiQuickSwitcher config={config} onConfigChange={loadData} />
        </div>
      </footer>
    </div>
  );
}

export default App;
