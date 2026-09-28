import { Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { dueQueue, localDateString, nextReview, elapsedDaysForReview, type FavoriteVocabulary, type Grade } from "@openkoto/core";
import { Button } from "../components/ui/button";
import { useLibrary, useRecords } from "../lib/library";
import { gradeCard, undoReview } from "../lib/vocab";

const GRADES: { grade: Grade; key: string; className: string }[] = [
  { grade: 1, key: "review.again", className: "border-[var(--srs-weak)] text-[var(--srs-weak)]" },
  { grade: 2, key: "review.hard", className: "border-[var(--srs-fading)] text-[var(--srs-fading)]" },
  { grade: 3, key: "review.good", className: "border-[var(--srs-strong)] text-[var(--srs-strong)]" },
  { grade: 4, key: "review.easy", className: "border-primary text-primary" },
];

function intervalLabel(days: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (days <= 0) return t("review.today");
  if (days < 30) return t("review.days", { count: days });
  if (days < 365) return t("review.months", { count: Math.round(days / 30) });
  return t("review.years", { count: Math.round((days / 365) * 10) / 10 });
}

export function ReviewPage() {
  const { t } = useTranslation();
  const { write } = useLibrary();
  const rows = useRecords<FavoriteVocabulary>("Vocabulary");
  const [flipped, setFlipped] = useState(false);
  const [history, setHistory] = useState<{ before: FavoriteVocabulary; event: Record<string, unknown> }[]>([]);
  const [done, setDone] = useState(0);
  const today = localDateString(new Date());

  const queue = useMemo(() => (rows ? dueQueue(rows.map((r) => r.payload), today) : []), [rows, today]);
  const card = queue[0];

  const previews = useMemo(() => {
    if (!card) return null;
    const elapsed = elapsedDaysForReview(card, today);
    // Again/Hard keep the card due today (same-day learning step, SRS spec §2.8).
    return Object.fromEntries(GRADES.map(({ grade }) => [grade, grade >= 3 ? nextReview(card.stability, card.difficulty, elapsed, grade).intervalDays : 0]));
  }, [card, today]);

  const grade = useCallback(
    async (g: Grade) => {
      if (!card) return;
      setFlipped(false);
      setDone((n) => n + 1);
      const { event } = await gradeCard(write, card, g);
      setHistory((h) => [...h.slice(-19), { before: card, event }]);
    },
    [card, write],
  );

  const undo = useCallback(async () => {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((h) => h.slice(0, -1));
    setDone((n) => Math.max(0, n - 1));
    await undoReview(write, previous.before, previous.event as never);
  }, [history, write]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (flipped && ["1", "2", "3", "4"].includes(e.key)) {
        void grade(Number(e.key) as Grade);
      } else if (e.key.toLowerCase() === "u") {
        void undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flipped, grade, undo]);

  if (!rows) return <p className="text-muted-foreground">{t("common.loading")}</p>;

  if (!card) {
    return (
      <div className="mx-auto max-w-md text-center py-16 space-y-4">
        <p className="text-4xl">🎉</p>
        <h1 className="text-xl font-semibold">{done ? t("review.finished", { count: done }) : t("review.nothingDue")}</h1>
        <p className="text-muted-foreground">{rows.length ? t("review.comeBack") : t("review.empty")}</p>
        <Link to="/vocab" className="text-primary hover:underline">
          {t("review.toVocab")}
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{t("review.remaining", { count: queue.length })}</span>
        <Button variant="ghost" size="sm" disabled={!history.length} onClick={() => void undo()} title="U">
          <Undo2 size={16} /> {t("review.undo")}
        </Button>
      </div>

      <button
        type="button"
        onClick={() => setFlipped((f) => !f)}
        className="w-full min-h-[280px] rounded-2xl border border-border bg-card p-8 flex flex-col items-center justify-center gap-4 text-center"
        aria-label={t("review.flip")}
      >
        <p className="text-4xl font-semibold break-words">{card.word}</p>
        {flipped ? (
          <div className="space-y-3">
            {card.reading && <p className="text-lg text-muted-foreground">{card.reading}</p>}
            <p className="text-xl">{card.meaning}</p>
            {card.example && <p className="text-sm text-muted-foreground italic">{card.example}</p>}
            {card.sourceArticleTitle && <p className="text-xs text-muted-foreground">— {card.sourceArticleTitle}</p>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("review.tapToFlip")}</p>
        )}
      </button>

      {flipped && previews && (
        <div className="grid grid-cols-4 gap-2">
          {GRADES.map(({ grade: g, key, className }) => (
            <button
              key={g}
              type="button"
              onClick={() => void grade(g)}
              className={`rounded-xl border-2 bg-card py-3 flex flex-col items-center gap-0.5 hover:bg-accent ${className}`}
            >
              <span className="font-medium">{t(key)}</span>
              <span className="text-xs opacity-80">{intervalLabel(previews[g] ?? 0, t)}</span>
              <span className="text-[10px] text-muted-foreground">{g}</span>
            </button>
          ))}
        </div>
      )}
      <p className="text-center text-xs text-muted-foreground">{t("review.shortcuts")}</p>
    </div>
  );
}
