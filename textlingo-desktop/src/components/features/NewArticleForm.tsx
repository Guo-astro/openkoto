import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { FileText, Loader2, Link, Clipboard, Info, Sparkles } from "lucide-react";
import { Article } from "../../types";
import { useAiClean, CLEAN_MIN_CHARS } from "../../lib/hooks";
import { AiCleanPanel } from "./AiCleanPanel";

interface NewArticleFormProps {
    onSave?: (article: Article) => void;
    onCancel: () => void;
    initialArticle?: Article;
}

export function NewArticleForm({ onSave, onCancel, initialArticle }: NewArticleFormProps) {
    const { t } = useTranslation();
    const [title, setTitle] = useState(initialArticle?.title || "");
    const [content, setContent] = useState(initialArticle?.content || "");
    const [sourceUrl, setSourceUrl] = useState(initialArticle?.source_url || "");
    const [isSaving, setIsSaving] = useState(false);
    const [isFetching, setIsFetching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const {
        aiReady,
        isCleaning,
        progress: cleanProgress,
        result: cleanResult,
        showingRaw,
        clean,
        toggleRaw,
        reset: resetClean,
        raw: cleanRaw,
    } = useAiClean();

    const isBusy = isSaving || isFetching || isCleaning;
    const canClean = aiReady && !isBusy && content.trim().length >= CLEAN_MIN_CHARS;

    /** 粘贴进来的正文往往也带着导航、版权尾巴——就地清一遍，正文逐字不动 */
    const runClean = async (source: { title: string; content: string }) => {
        setError(null);
        const outcome = await clean(source);
        setTitle(outcome.title);
        setContent(outcome.content);
        if (outcome.status === "failed") setError(outcome.error);
    };

    const handleToggleRaw = () => {
        const next = toggleRaw();
        if (!next) return;
        setTitle(next.title);
        setContent(next.content);
    };

    // 「重新清洗」从清洗前那一版重来，否则会在已删过的正文上再删一轮
    const handleRetryClean = () => runClean(cleanRaw() ?? { title, content });

    const handleSave = async () => {
        if (!content.trim()) {
            setError(t("newArticle.errors.contentRequired"));
            return;
        }

        setIsSaving(true);
        setError(null);
        try {
            let article: Article;
            if (initialArticle) {
                // Update existing article
                article = await invoke<Article>("update_article", {
                    id: initialArticle.id,
                    title: title.trim() || t("articleList.untitled"),
                    content,
                    sourceUrl: sourceUrl.trim() || undefined,
                });
            } else {
                // Create new article
                article = await invoke<Article>("create_article", {
                    title: title.trim() || t("articleList.untitled"),
                    content,
                    sourceUrl: sourceUrl.trim() || undefined,
                });
            }
            onSave?.(article);
        } catch (err) {
            setError(err as string);
        } finally {
            setIsSaving(false);
        }
    };

    const handlePaste = async () => {
        try {
            const text = await navigator.clipboard.readText();
            resetClean();
            setContent(text);
        } catch (err) {
            setError(t("newArticle.errors.clipboardError"));
        }
    };

    const fetchFromUrl = async (url: string): Promise<{ title: string; content: string }> => {
        return await invoke("fetch_url_content", { url }) as { title: string; content: string };
    };

    const handleFetchFromUrl = async () => {
        if (!sourceUrl.trim()) {
            setError(t("newArticle.errors.urlRequired"));
            return;
        }

        // Simple URL validation
        const url = sourceUrl.trim();
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            setError(t("newArticle.errors.urlInvalid"));
            return;
        }

        setIsFetching(true);
        setError(null);
        resetClean();
        try {
            const fetched = await fetchFromUrl(url);

            // Set title if empty, and set content
            if (!title.trim() && fetched.title) {
                setTitle(fetched.title);
            }
            setContent(fetched.content);

            // Check if content is empty or too short
            if (!fetched.content || fetched.content.trim().length < 10) {
                setError(t("newArticle.errors.noContentExtracted"));
            }
        } catch (err) {
            setError(err as string);
        } finally {
            setIsFetching(false);
        }
    };

    const handlePasteUrlAndFetch = async () => {
        try {
            const url = await navigator.clipboard.readText();
            // Check if it looks like a URL
            if (url.startsWith("http://") || url.startsWith("https://")) {
                setSourceUrl(url);
                // Auto-fetch after pasting URL
                setIsFetching(true);
                setError(null);
                resetClean();
                try {
                    const fetched = await fetchFromUrl(url);

                    if (!title.trim() && fetched.title) {
                        setTitle(fetched.title);
                    }
                    setContent(fetched.content);

                    // Check if content is empty or too short
                    if (!fetched.content || fetched.content.trim().length < 10) {
                        setError(t("newArticle.errors.noContentExtracted"));
                    }
                } catch (err) {
                    setError(err as string);
                } finally {
                    setIsFetching(false);
                }
            } else {
                setError(t("newArticle.errors.clipboardNotUrl"));
            }
        } catch (err) {
            setError(t("newArticle.errors.clipboardError"));
        }
    };

    return (
        <div className="flex flex-col h-full">
            <div className="flex-1 space-y-4 overflow-y-auto pr-1">
                {error && (
                    <div className="p-3 bg-red-900/30 border border-red-700 rounded-lg text-red-300 text-sm">
                        {error}
                    </div>
                )}
                {/* Hint */}
                <div className="flex gap-3 p-3 bg-primary/10 border border-primary/20 rounded-lg text-sm text-foreground/90 mb-4">
                    <Info className="w-5 h-5 shrink-0 text-primary mt-0.5" />
                    <p>{t("newArticle.hint", "This feature is for sentence-by-sentence intensive reading...")}</p>
                </div>

                {/* Title */}
                <div>
                    <label className="block text-sm font-medium text-foreground mb-2">
                        {t("newArticle.titleLabel")} <span className="text-muted-foreground">{t("newArticle.optional")}</span>
                    </label>
                    <Input
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder={t("newArticle.titlePlaceholder")}
                    />
                </div>

                {/* Source URL */}
                <div>
                    <label className="block text-sm font-medium text-foreground mb-2">
                        {t("newArticle.sourceUrlLabel")} <span className="text-muted-foreground">{t("newArticle.optional")}</span>
                    </label>
                    <div className="flex gap-2 items-center">
                        <Input
                            value={sourceUrl}
                            onChange={(e) => setSourceUrl(e.target.value)}
                            placeholder={t("newArticle.sourceUrlPlaceholder")}
                            className="flex-1"
                        />
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleFetchFromUrl}
                            disabled={isFetching || !sourceUrl.trim()}
                            className="gap-1"
                        >
                            {isFetching ? (
                                <Loader2 size={16} className="animate-spin" />
                            ) : (
                                <Link size={16} />
                            )}
                            {t("newArticle.fetch")}
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handlePasteUrlAndFetch}
                            disabled={isFetching}
                            title={t("newArticle.pasteUrlAndFetch")}
                            className="gap-1"
                        >
                            <Clipboard size={16} />
                        </Button>
                    </div>
                </div>

                <AiCleanPanel
                    isCleaning={isCleaning}
                    progress={cleanProgress}
                    result={cleanResult}
                    showingRaw={showingRaw}
                    onToggleRaw={handleToggleRaw}
                    onRetry={handleRetryClean}
                    disabled={isBusy}
                />

                {/* Content */}
                <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                        <label className="block text-sm font-medium text-foreground">
                            {showingRaw ? t("webImport.contentLabelRaw") : t("newArticle.contentLabel")}{" "}
                            <span className="text-red-500">{t("newArticle.required")}</span>
                        </label>
                        <div className="flex items-center gap-1">
                            {/* 粘进来的网页正文常带导航/版权尾巴，就地清一遍再逐句精讲 */}
                            <Button
                                variant="secondary"
                                size="sm"
                                className="gap-1.5"
                                onClick={() => runClean({ title, content })}
                                disabled={!canClean}
                                title={aiReady ? undefined : t("webImport.modes.smartUnavailable")}
                            >
                                {isCleaning ? (
                                    <Loader2 size={14} className="animate-spin" />
                                ) : (
                                    <Sparkles size={14} />
                                )}
                                {t("webImport.clean.action")}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={handlePaste} disabled={isBusy}>
                                {t("newArticle.pasteFromClipboard")}
                            </Button>
                        </div>
                    </div>
                    <Textarea
                        value={content}
                        onChange={(e) => setContent(e.target.value)}
                        placeholder={t("newArticle.contentPlaceholder")}
                        className="min-h-[300px] font-mono text-sm"
                        disabled={isCleaning}
                    />
                </div>
            </div>

            <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-border">
                <Button variant="secondary" onClick={onCancel} disabled={isSaving || isFetching}>
                    {t("newArticle.cancel")}
                </Button>
                <Button onClick={handleSave} disabled={isSaving || isFetching} className="gap-2">
                    {isSaving ? (
                        <>
                            <Loader2 size={16} className="animate-spin" />
                            {t("newArticle.saving")}
                        </>
                    ) : (
                        <>
                            <FileText size={16} />
                            {t("newArticle.createArticle")}
                        </>
                    )}
                </Button>
            </div>
        </div>
    );
}
