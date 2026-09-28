import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Loader2, Globe, Check, Eye, Sparkles, FileText, AlertTriangle } from "lucide-react";
import { Article } from "../../types";
import { useAiClean, CLEAN_MIN_CHARS } from "../../lib/hooks";
import { AiCleanPanel } from "./AiCleanPanel";

interface WebImportFormProps {
  onSave?: (article: Article) => void;
  onCancel: () => void;
}

interface FetchedContent {
  title: string;
  content: string;
}

type ImportMode = "classic" | "smart";

export function WebImportForm({ onSave, onCancel }: WebImportFormProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [fetchSource, setFetchSource] = useState<"local" | null>(null);

  const [mode, setMode] = useState<ImportMode>("classic");
  // 保留经典模式的抓取结果，切回经典模式或清洗失败时可以还原
  const [rawTitle, setRawTitle] = useState("");
  const [rawContent, setRawContent] = useState("");
  const {
    aiReady,
    isCleaning,
    progress: cleanProgress,
    result: cleanResult,
    showingRaw,
    clean,
    toggleRaw,
    reset: resetClean,
  } = useAiClean();

  const isValidUrl = (value: string) =>
    value.startsWith("http://") || value.startsWith("https://");

  const isBusy = isFetching || isCleaning || isImporting;
  const canImport = !!previewLoaded && content.trim().length >= 10 && isValidUrl(url.trim());
  /// 手动清洗按编辑区里**当前**的正文来（用户可能已经手改过），不限于抓取那一版。
  const canCleanNow = aiReady && !isBusy && content.trim().length >= CLEAN_MIN_CHARS;

  const fetchLocal = async (sourceUrl: string): Promise<FetchedContent> => {
    const local = await invoke<FetchedContent>("fetch_url_content", { url: sourceUrl });
    setFetchSource("local");
    return local;
  };

  /** 在抓取结果上再跑一遍模型清洗，只删无关行，不改写原文 */
  const runSmartClean = async (sourceTitle: string, sourceContent: string) => {
    if (sourceContent.trim().length < CLEAN_MIN_CHARS) return;
    setError(null);

    const outcome = await clean({ title: sourceTitle, content: sourceContent });
    setTitle(outcome.title);
    setContent(outcome.content);
    if (outcome.status === "failed") setError(outcome.error);
  };

  /** 手动清洗：不切模式，就地清洗编辑区里现在这份正文 */
  const handleCleanNow = async () => {
    setRawTitle(title);
    setRawContent(content);
    await runSmartClean(title, content);
  };

  const handleModeChange = async (next: ImportMode) => {
    if (next === mode || isBusy) return;
    setMode(next);
    setError(null);

    if (next === "classic") {
      resetClean();
      if (previewLoaded) {
        setTitle(rawTitle);
        setContent(rawContent);
      }
      return;
    }

    if (previewLoaded && rawContent && aiReady) {
      await runSmartClean(rawTitle, rawContent);
    }
  };

  const handleFetchPreview = async () => {
    const normalizedUrl = url.trim();
    if (!normalizedUrl) {
      setError(t("webImport.errors.urlRequired"));
      return;
    }
    if (!isValidUrl(normalizedUrl)) {
      setError(t("webImport.errors.urlInvalid"));
      return;
    }

    setIsFetching(true);
    setError(null);
    setPreviewLoaded(false);
    setFetchSource(null);
    resetClean();

    try {
      const fetched = await fetchLocal(normalizedUrl);
      const nextTitle = fetched.title?.trim() || "";
      const nextContent = fetched.content?.trim() || "";

      setRawTitle(nextTitle);
      setRawContent(nextContent);
      setTitle(nextTitle);
      setContent(nextContent);
      setPreviewLoaded(true);

      if (nextContent.length < 10) {
        setError(t("webImport.errors.contentTooShort"));
        return;
      }

      if (mode === "smart" && aiReady) {
        await runSmartClean(nextTitle, nextContent);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setIsFetching(false);
    }
  };

  const handleToggleRaw = () => {
    const next = toggleRaw();
    if (!next) return;
    setTitle(next.title);
    setContent(next.content);
  };

  const handleImport = async () => {
    const normalizedUrl = url.trim();
    if (!canImport) {
      setError(t("webImport.errors.contentTooShort"));
      return;
    }

    setIsImporting(true);
    setError(null);
    try {
      const article = await invoke<Article>("import_web_material_cmd", {
        url: normalizedUrl,
        title: title.trim() || undefined,
        content,
      });
      onSave?.(article);
    } catch (err) {
      setError(String(err));
    } finally {
      setIsImporting(false);
    }
  };

  const modes: { value: ImportMode; label: string; icon: typeof FileText }[] = [
    { value: "classic", label: t("webImport.modes.classic"), icon: FileText },
    { value: "smart", label: t("webImport.modes.smart"), icon: Sparkles },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {error && (
          <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm break-words">
            {error}
          </div>
        )}

        <div>
          <div className="inline-flex p-1 rounded-lg bg-muted/50 border border-border">
            {modes.map((item) => {
              const Icon = item.icon;
              const active = mode === item.value;
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => handleModeChange(item.value)}
                  disabled={isBusy}
                  aria-pressed={active}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors disabled:opacity-50 ${
                    active
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon size={14} />
                  {item.label}
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {mode === "classic" ? t("webImport.modes.classicHint") : t("webImport.modes.smartHint")}
          </p>
          {mode === "smart" && !aiReady && (
            <p className="flex items-start gap-1.5 text-xs text-amber-500 mt-2">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              {t("webImport.modes.smartUnavailable")}
            </p>
          )}
        </div>

        <div className="flex gap-3 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm text-foreground/90">
          <Globe className="w-5 h-5 shrink-0 text-blue-500 mt-0.5" />
          <p>{t("webImport.hint")}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            {t("webImport.urlLabel")}
          </label>
          <div className="flex gap-2">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("webImport.urlPlaceholder")}
              disabled={isBusy}
            />
            <Button onClick={handleFetchPreview} disabled={isBusy} className="gap-2">
              {isFetching ? <Loader2 size={16} className="animate-spin" /> : <Eye size={16} />}
              {isFetching ? t("webImport.fetching") : t("webImport.fetchPreview")}
            </Button>
          </div>
          {fetchSource && (
            <p className="text-xs text-muted-foreground mt-2">
              {t("webImport.previewSourceLocal")}
            </p>
          )}
        </div>

        <AiCleanPanel
          isCleaning={isCleaning}
          progress={cleanProgress}
          result={cleanResult}
          showingRaw={showingRaw}
          onToggleRaw={handleToggleRaw}
          onRetry={() => runSmartClean(rawTitle, rawContent)}
          disabled={isBusy}
        />

        <div>
          <label className="block text-sm font-medium text-foreground mb-2">
            {t("webImport.titleLabel")}
          </label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("webImport.titlePlaceholder")}
            disabled={isImporting}
          />
        </div>

        <div>
          <div className="flex items-center justify-between gap-2 mb-2">
            <label className="block text-sm font-medium text-foreground">
              {showingRaw ? t("webImport.contentLabelRaw") : t("webImport.contentLabel")}
            </label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t("webImport.wordCount", { count: content.trim().length })}
              </span>
              {/* 明摆着的按钮：不必先切「智能模式」再重抓，抓完/改完随时清一遍 */}
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5"
                onClick={handleCleanNow}
                disabled={!canCleanNow}
                title={aiReady ? undefined : t("webImport.modes.smartUnavailable")}
              >
                {isCleaning ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                {t("webImport.clean.action")}
              </Button>
            </div>
          </div>
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t("webImport.contentPlaceholder")}
            className="min-h-[220px]"
            disabled={isImporting}
          />
        </div>
      </div>

      <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-border">
        <Button variant="secondary" onClick={onCancel} disabled={isBusy}>
          {t("common.cancel")}
        </Button>
        <Button onClick={handleImport} disabled={!canImport || isBusy} className="gap-2">
          {isImporting ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              {t("webImport.importing")}
            </>
          ) : (
            <>
              <Check size={16} />
              {t("webImport.import")}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
