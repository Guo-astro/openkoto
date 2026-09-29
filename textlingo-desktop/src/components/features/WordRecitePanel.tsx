import { useEffect, useMemo, useState } from "react";
import { useCloudDataChanged } from "../../lib/hooks/useCloudDataChanged";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { FavoriteVocabulary, ReviewStats } from "../../types";
import type { AppConfig } from "../../lib/tauri";
import { currentRetention } from "../../lib/srs";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";

interface WordRecitePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packId: string;
  packName: string;
  onReviewed: () => Promise<void> | void;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function WordRecitePanel({
  open,
  onOpenChange,
  packId,
  packName,
  onReviewed,
}: WordRecitePanelProps) {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<FavoriteVocabulary[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [limits, setLimits] = useState<{ newLimit: number; reviewLimit: number }>({
    newLimit: 20,
    reviewLimit: 100,
  });

  const current = useMemo(() => queue[currentIndex], [queue, currentIndex]);
  const retention = useMemo(() => (current ? currentRetention(current) : null), [current]);

  // 云同步带来其他设备的复习:刷新统计;队列已做完时重新取到期卡(不打断进行中的复习)
  useCloudDataChanged(() => {
    if (!open) return;
    void loadStats();
    if (currentIndex >= queue.length) {
      setCurrentIndex(0);
      void loadQueue();
    }
  });

  useEffect(() => {
    if (!open) return;
    setCurrentIndex(0);
    setShowAnswer(false);
    void loadQueue();
    void loadStats();
    void invoke<AppConfig>("get_config")
      .then((config) =>
        setLimits({
          newLimit: config.srs_daily_new_limit ?? 20,
          reviewLimit: config.srs_daily_review_limit ?? 100,
        })
      )
      .catch(() => undefined);
  }, [open, packId]);

  const loadQueue = async () => {
    setIsLoading(true);
    try {
      const today = formatLocalDate(new Date());
      const due = await invoke<FavoriteVocabulary[]>("get_due_vocabulary_queue_cmd", {
        packId,
        dateLocal: today,
      });
      setQueue(due);
    } catch (error) {
      console.error("Failed to load due queue:", error);
      setQueue([]);
    } finally {
      setIsLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const result = await invoke<ReviewStats>("get_review_stats_cmd", {
        packId,
        dateLocal: formatLocalDate(new Date()),
      });
      setStats(result);
    } catch (error) {
      console.error("Failed to load review stats:", error);
    }
  };

  const handleGrade = async (grade: "unknown" | "uncertain" | "known") => {
    if (!current) return;
    setIsSubmitting(true);
    try {
      const today = formatLocalDate(new Date());
      await invoke<FavoriteVocabulary>("review_vocabulary_cmd", {
        vocabularyId: current.id,
        grade,
        dateLocal: today,
      });

      setQueue((prev) => prev.filter((item) => item.id !== current.id));
      setCurrentIndex(0);
      setShowAnswer(false);
      void loadStats();
      await onReviewed();
    } catch (error) {
      console.error("Failed to review vocabulary:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const progressBar = (label: string, value: number, limit: number, color: string) => (
    <div className="flex-1">
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <span>
          {Math.min(value, limit)}/{limit}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted/60">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${limit > 0 ? Math.min((value / limit) * 100, 100) : 0}%`,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {packName} - {t("favorites.todayReview", "今日复习")}
          </DialogTitle>
        </DialogHeader>

        {stats && (
          <div className="flex gap-4 rounded-lg border border-border/50 bg-muted/20 px-3 py-2">
            {progressBar(
              t("favorites.progressNew", "今日新词"),
              stats.new_today,
              limits.newLimit,
              "var(--srs-strong)"
            )}
            {progressBar(
              t("favorites.progressReview", "今日复习"),
              stats.review_today,
              limits.reviewLimit,
              "var(--srs-fading)"
            )}
          </div>
        )}

        {isLoading ? (
          <div className="py-12 text-center text-muted-foreground">
            {t("favorites.loadingQueue", "加载复习队列中...")}
          </div>
        ) : !current ? (
          <div className="space-y-3 py-10 text-center">
            <div className="text-lg font-semibold">{t("favorites.reviewDone", "今日已完成")}</div>
            <div className="text-sm text-muted-foreground">
              {t("favorites.reviewDoneDesc", "当前没有到期卡片")}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
              {t("favorites.queuePosition", "第 {{current}} 张 / 共 {{total}} 张", {
                current: currentIndex + 1,
                total: queue.length,
              })}
            </div>
            <div className="rounded-xl border border-border bg-card p-6">
              <div className="mb-3 text-2xl font-bold text-primary">{current.word}</div>
              {current.reading && <div className="mb-2 text-xs text-muted-foreground">{current.reading}</div>}

              {showAnswer ? (
                <div className="space-y-2 text-sm">
                  <div className="font-medium">{current.meaning}</div>
                  {current.usage && <div className="text-muted-foreground">{current.usage}</div>}
                  {current.example && <div className="italic text-muted-foreground">{current.example}</div>}
                  {current.explanation && <div className="text-muted-foreground">{current.explanation}</div>}
                  {retention !== null && (
                    <div className="pt-1 text-[11px] text-muted-foreground/70">
                      {t("favorites.retention", "保持率")} {Math.round(retention * 100)}%
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  {t("favorites.recallHint", "先尝试回忆，再点击“显示答案”")}
                </div>
              )}
            </div>

            {!showAnswer ? (
              <Button className="w-full" onClick={() => setShowAnswer(true)}>
                {t("favorites.showAnswer", "显示答案")}
              </Button>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                <Button
                  variant="danger"
                  disabled={isSubmitting}
                  onClick={() => void handleGrade("unknown")}
                >
                  {t("favorites.gradeUnknown", "不认识")}
                </Button>
                <Button
                  variant="outline"
                  disabled={isSubmitting}
                  onClick={() => void handleGrade("uncertain")}
                >
                  {t("favorites.gradeUncertain", "模糊")}
                </Button>
                <Button disabled={isSubmitting} onClick={() => void handleGrade("known")}>
                  {t("favorites.gradeKnown", "认识")}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
