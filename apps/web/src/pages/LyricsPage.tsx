import { Download, Languages, Loader2, Pause, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { parseLyrics, toLrc, type Article, type ArticleSegment, type LyricsMeta } from "@openkoto/core";
import { AiSettings, useAiMode } from "../components/AiSettings";
import { SegmentReader, type SegmentRow } from "../components/SegmentReader";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { aiEngine } from "../lib/ai";
import { useLibrary, useRecord, useRecords } from "../lib/library";
import { useSession } from "../lib/session";

export function LyricsListPage() {
  const { t } = useTranslation();
  const { write } = useLibrary();
  const { account } = useSession();
  const navigate = useNavigate();
  const articles = useRecords<Article>("Article");
  const metas = useRecords<LyricsMeta>("LyricsMeta");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ title: "", artist: "", raw: "" });
  const songs = (articles ?? []).filter((a) => a.payload.sourceType === "lyrics");
  const limit = account?.plan === "free" ? 30 : null;

  const create = async () => {
    const parsed = parseLyrics(draft.raw);
    const lines = parsed.lines.filter((l) => l.text.trim());
    if (!lines.length) return;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const title = draft.title.trim() || parsed.meta.title || lines[0]!.text.slice(0, 30);
    await write("Article", id, { payload: { id, title, content: lines.map((l) => l.text).join("\n"), sourceType: "lyrics", createdAt: now } });
    await write("LyricsMeta", id, {
      payload: {
        articleId: id,
        artist: draft.artist.trim() || parsed.meta.artist || null,
        album: parsed.meta.album ?? null,
        lrcOffsetMs: parsed.meta.offsetMs ?? 0,
        sourceFormat: parsed.format,
      },
    });
    for (const [order, line] of lines.entries()) {
      const segId = crypto.randomUUID();
      await write("Segment", segId, {
        payload: { id: segId, articleId: id, order, text: line.text, isNewParagraph: false, startTime: line.startTime ?? null, endTime: line.endTime ?? null, segmentationRevision: 0, createdAt: now },
      });
    }
    setDraft({ title: "", artist: "", raw: "" });
    setOpen(false);
    navigate(`/lyrics/${id}`);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold mr-auto">
          {t("lyrics.title")} {limit && <span className="text-base font-normal text-muted-foreground">{songs.length}/{limit}</span>}
        </h1>
        <Button size="sm" onClick={() => setOpen((v) => !v)} disabled={limit !== null && songs.length >= limit}>
          <Plus size={16} /> {t("lyrics.add")}
        </Button>
      </div>
      {open && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder={t("lyrics.songTitle")} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label={t("lyrics.songTitle")} />
            <Input placeholder={t("lyrics.artist")} value={draft.artist} onChange={(e) => setDraft({ ...draft, artist: e.target.value })} aria-label={t("lyrics.artist")} />
          </div>
          <Textarea rows={10} placeholder={t("lyrics.paste")} value={draft.raw} onChange={(e) => setDraft({ ...draft, raw: e.target.value })} aria-label={t("lyrics.paste")} />
          <div className="flex items-center justify-between gap-2">
            <label className="text-sm text-primary cursor-pointer">
              {t("lyrics.openFile")}
              <input
                type="file"
                accept=".lrc,.txt,.srt"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setDraft({ ...draft, raw: await f.text(), title: draft.title || f.name.replace(/\.[^.]+$/, "") });
                }}
              />
            </label>
            <Button onClick={() => void create()} disabled={!draft.raw.trim()}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}
      {songs.length === 0 ? (
        <p className="py-12 text-center text-muted-foreground">{t("lyrics.empty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {songs.map((s) => {
            const meta = metas?.find((m) => m.id === s.id)?.payload;
            return (
              <li key={s.id} className="flex items-center gap-3 p-3">
                <Link to={`/lyrics/${s.id}`} className="flex-1 min-w-0">
                  <p className="font-medium truncate">{s.payload.title}</p>
                  {meta?.artist && <p className="text-sm text-muted-foreground truncate">{meta.artist}</p>}
                </Link>
                <Button variant="ghost" size="sm" onClick={() => void write("Article", s.id, { deleted: true })} title={t("common.delete")}>
                  <Trash2 size={16} />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function LyricsDetailPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const articleId = id.toLowerCase();
  const { store, write } = useLibrary();
  const article = useRecord<Article>("Article", articleId);
  const meta = useRecord<LyricsMeta>("LyricsMeta", articleId);
  const segments = useLiveQuery(
    async () =>
      (await store.live("Segment"))
        .filter((r) => String(r.payload?.articleId ?? "").toLowerCase() === articleId)
        .map((r) => ({ id: r.id, payload: r.payload as unknown as ArticleSegment }))
        .sort((a, b) => a.payload.order - b.payload.order) as SegmentRow[],
    [store, articleId],
  );
  const { mode, target } = useAiMode();
  const [, bump] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const started = useRef<number>(0);
  const timed = useMemo(() => (segments ?? []).some((s) => typeof s.payload.startTime === "number"), [segments]);

  // "Sing along": follow the timestamps from a manual start while the song plays elsewhere.
  useEffect(() => {
    if (!playing) return;
    started.current = performance.now() - position * 1000;
    const timer = setInterval(() => setPosition((performance.now() - started.current) / 1000), 200);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const activeId = useMemo(() => {
    if (!timed || (!playing && position === 0)) return null;
    const current = (segments ?? []).filter((s) => (s.payload.startTime ?? Infinity) <= position).at(-1);
    return current?.id ?? null;
  }, [segments, position, playing, timed]);

  const translate = async () => {
    if (!mode || !segments?.length) return;
    setBusy(true);
    setError(null);
    try {
      const translations = await aiEngine(mode).translateLyrics(
        segments.map((s) => s.payload.text),
        target,
        { title: article?.payload.title, artist: meta?.payload.artist ?? undefined },
      );
      for (const [i, s] of segments.entries()) {
        const tr = translations[i];
        if (tr) await write("Segment", s.id, { payload: { ...s.payload, translation: tr } as never });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const exportLrc = () => {
    const lines = (segments ?? []).flatMap((s) => {
      const base = { startTime: s.payload.startTime ?? undefined, endTime: s.payload.endTime ?? undefined };
      return [{ ...base, text: s.payload.text }, ...(s.payload.translation ? [{ ...base, text: s.payload.translation }] : [])];
    });
    const lrc = toLrc({ format: timed ? "lrc" : "txt", meta: { title: article?.payload.title, artist: meta?.payload.artist ?? undefined }, lines } as never);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lrc], { type: "text/plain" }));
    a.download = `${article?.payload.title ?? "lyrics"}.lrc`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (article === null) return <p className="text-muted-foreground">{t("reader.notFound")}</p>;
  if (!article || !segments) return <p className="text-muted-foreground">{t("common.loading")}</p>;

  return (
    <div className="space-y-5">
      <Link to="/lyrics" className="text-sm text-muted-foreground hover:text-foreground">
        ← {t("nav.lyrics")}
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <div className="basis-full">
          <h1 className="text-xl font-semibold">{article.payload.title}</h1>
          {meta?.payload.artist && <p className="text-muted-foreground">{meta.payload.artist}</p>}
        </div>
        <Button size="sm" disabled={!mode || busy} onClick={() => void translate()}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Languages size={16} />} {t("lyrics.translate")}
        </Button>
        {timed && (
          <Button size="sm" variant="outline" onClick={() => setPlaying((p) => !p)}>
            {playing ? <Pause size={16} /> : <Play size={16} />} {playing ? t("lyrics.pause") : t("lyrics.singAlong")}
          </Button>
        )}
        {timed && position > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setPlaying(false);
              setPosition(0);
            }}
          >
            {t("lyrics.reset")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={exportLrc}>
          <Download size={16} /> LRC
        </Button>
        <AiSettings onChange={() => bump((n) => n + 1)} />
      </div>
      {!mode && <p className="text-sm text-muted-foreground">{t("reader.noAi")}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <SegmentReader segments={segments} articleId={articleId} articleTitle={article.payload.title} mode={mode} target={target} showTranslation activeId={activeId} lineMode />
    </div>
  );
}
