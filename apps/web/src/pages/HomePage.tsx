import { BookOpen, Brain, Music } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { dueQueue, localDateString, type Article, type Book, type FavoriteVocabulary } from "@openkoto/core";
import { useRecords } from "../lib/library";
import { useSession } from "../lib/session";

function Tile({ to, icon: Icon, title, value, hint }: { to: string; icon: typeof Brain; title: string; value: string | number; hint: string }) {
  return (
    <Link to={to} className="rounded-xl border border-border bg-card p-5 hover:border-primary/50 transition-colors">
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Icon size={16} aria-hidden /> {title}
      </div>
      <p className="mt-2 text-3xl font-semibold">{value}</p>
      <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
    </Link>
  );
}

export function HomePage() {
  const { t } = useTranslation();
  const { account } = useSession();
  const vocab = useRecords<FavoriteVocabulary>("Vocabulary");
  const books = useRecords<Book>("Book");
  const articles = useRecords<Article>("Article");
  const today = localDateString(new Date());
  const due = useMemo(() => (vocab ? dueQueue(vocab.map((r) => r.payload), today).length : 0), [vocab, today]);
  const lyrics = (articles ?? []).filter((a) => a.payload.sourceType === "lyrics").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{t("home.greeting", { name: account?.user.name || account?.user.email })}</h1>
        <p className="text-sm text-muted-foreground">{t("home.subtitle")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Tile to="/review" icon={Brain} title={t("home.dueToday")} value={due} hint={t("home.totalWords", { count: vocab?.length ?? 0 })} />
        <Tile to="/library" icon={BookOpen} title={t("home.books")} value={books?.length ?? 0} hint={t("home.continueReading")} />
        <Tile to="/lyrics" icon={Music} title={t("home.lyrics")} value={lyrics} hint={t("home.lyricsHint")} />
      </div>
      {account?.plan === "free" && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-5 flex flex-wrap items-center gap-3">
          <p className="flex-1 text-sm">{t("home.upgradeHint")}</p>
          <Link to="/pricing" className="text-sm font-medium text-primary hover:underline">
            {t("account.upgrade")}
          </Link>
        </div>
      )}
    </div>
  );
}
