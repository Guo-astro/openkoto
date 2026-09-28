import { BookmarkPlus, Languages, Loader2, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ArticleSegment, FavoriteVocabulary, SegmentExplanation } from "@openkoto/core";
import { aiEngine, type AiMode } from "../lib/ai";
import { useLibrary, useRecords } from "../lib/library";
import { addVocabulary } from "../lib/vocab";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

export interface SegmentRow {
  id: string;
  payload: ArticleSegment;
}

interface Props {
  segments: SegmentRow[];
  articleId: string;
  articleTitle: string;
  mode: AiMode | null;
  target: string;
  showTranslation: boolean;
  /** Highlighted segment (lyrics playback). */
  activeId?: string | null;
  lineMode?: boolean;
}

/** Sentence-by-sentence reader with inline translation, AI explanation and "save word". */
export function SegmentReader({ segments, articleId, articleTitle, mode, target, showTranslation, activeId, lineMode }: Props) {
  const { t } = useTranslation();
  const { write } = useLibrary();
  const vocab = useRecords<FavoriteVocabulary>("Vocabulary");
  const [selected, setSelected] = useState<SegmentRow | null>(null);
  const [explanation, setExplanation] = useState<SegmentExplanation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const open = (seg: SegmentRow) => {
    setSelected(seg);
    setExplanation(seg.payload.explanation ?? null);
    setError(null);
    setSaved(null);
  };

  const explain = async () => {
    if (!selected || !mode) return;
    setBusy(true);
    setError(null);
    try {
      const result = await aiEngine(mode).explain(selected.payload.text, target);
      setExplanation(result);
      await write("Segment", selected.id, {
        payload: { ...selected.payload, explanation: result, translation: selected.payload.translation || result.translation } as never,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveWord = async (word: string, meaning: string, reading?: string | null) => {
    if (!selected) return;
    await addVocabulary(write, (vocab ?? []).map((v) => v.payload), {
      word,
      meaning,
      reading: reading ?? undefined,
      example: selected.payload.text,
      sourceArticleId: articleId,
      sourceArticleTitle: articleTitle,
      sourceSegmentId: selected.id,
    });
    setSaved(word);
  };

  const saveSelection = async () => {
    const text = window.getSelection()?.toString().trim();
    if (!text || text.length > 60) return;
    await saveWord(text, "");
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className={cn("leading-relaxed", lineMode ? "space-y-3" : "space-y-1")}>
        {segments.map((seg) => (
          <div key={seg.id} className={cn(seg.payload.isNewParagraph && !lineMode && "mt-4")}>
            <span
              role="button"
              tabIndex={0}
              onClick={() => open(seg)}
              onKeyDown={(e) => e.key === "Enter" && open(seg)}
              className={cn(
                "cursor-pointer rounded px-0.5 transition-colors hover:bg-accent",
                selected?.id === seg.id && "bg-accent",
                activeId === seg.id && "bg-primary/15 text-primary font-medium",
                lineMode ? "block text-lg" : "",
              )}
            >
              {seg.payload.readingText && <span className="block text-xs text-muted-foreground">{seg.payload.readingText}</span>}
              {seg.payload.text}
            </span>
            {showTranslation && seg.payload.translation && <span className={cn("block text-sm text-muted-foreground", !lineMode && "mb-2")}>{seg.payload.translation}</span>}
          </div>
        ))}
      </div>

      <aside className="lg:sticky lg:top-20 self-start rounded-xl border border-border bg-card p-4 space-y-3 text-sm">
        {!selected ? (
          <p className="text-muted-foreground">{t("reader.pickSentence")}</p>
        ) : (
          <>
            <p className="font-medium">{selected.payload.text}</p>
            {selected.payload.translation && (
              <p className="flex gap-2 text-muted-foreground">
                <Languages size={16} className="shrink-0 mt-0.5" aria-hidden /> {selected.payload.translation}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" disabled={!mode || busy} onClick={() => void explain()}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} {t("reader.explain")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void saveSelection()} title={t("reader.saveSelectionHint")}>
                <BookmarkPlus size={14} /> {t("reader.saveSelection")}
              </Button>
            </div>
            {!mode && <p className="text-xs text-muted-foreground">{t("reader.noAi")}</p>}
            {error && <p className="text-xs text-destructive">{error}</p>}
            {saved && <p className="text-xs text-primary">{t("reader.saved", { word: saved })}</p>}
            {explanation && (
              <div className="space-y-3 border-t border-border pt-3">
                {explanation.explanation && <p>{explanation.explanation}</p>}
                {explanation.vocabulary.length > 0 && (
                  <ul className="space-y-2">
                    {explanation.vocabulary.map((v) => (
                      <li key={v.word} className="flex items-start gap-2">
                        <div className="flex-1">
                          <p className="font-medium">
                            {v.word} {v.reading && <span className="text-xs text-muted-foreground">{v.reading}</span>}
                          </p>
                          <p className="text-muted-foreground">{v.meaning}</p>
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => void saveWord(v.word, v.meaning, v.reading)} title={t("reader.saveWord")}>
                          <BookmarkPlus size={14} />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {explanation.grammarPoints.length > 0 && (
                  <ul className="space-y-1">
                    {explanation.grammarPoints.map((g) => (
                      <li key={g.point}>
                        <span className="font-medium">{g.point}</span> — <span className="text-muted-foreground">{g.explanation}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
