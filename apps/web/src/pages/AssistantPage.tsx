import { Bot, Loader2, Send, Wrench } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import { HttpError, request } from "../lib/api";
import { useSession } from "../lib/session";
import { useOptionalLibrary } from "../lib/library";

interface Step {
  tool: string;
  ok: boolean;
  summary: string;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  steps?: Step[];
  credits?: number;
}

const EXAMPLES = ["assistant.example1", "assistant.example2", "assistant.example3"];

export function AssistantPage() {
  const { t } = useTranslation();
  const { account, refresh } = useSession();
  const library = useOptionalLibrary();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const locked = account?.plan === "free";

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    const next: Turn[] = [...turns, { role: "user", content: text.trim() }];
    setTurns(next);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const res = await request<{ reply: string; steps: Step[]; credits: number }>("/api/v1/agent/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: next.map(({ role, content }) => ({ role, content })),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      setTurns([...next, { role: "assistant", content: res.reply, steps: res.steps, credits: res.credits }]);
      // The agent may have changed the library on the server: pull it now.
      void library?.syncNow();
      void refresh();
    } catch (err) {
      setError(
        err instanceof HttpError
          ? err.code === "INSUFFICIENT_CREDITS"
            ? t("assistant.noCredits")
            : err.code === "PLAN_REQUIRED"
              ? t("assistant.needsPlus")
              : err.message
          : t("common.networkError"),
      );
    } finally {
      setBusy(false);
      setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  return (
    <div className="mx-auto max-w-2xl flex flex-col gap-4 min-h-[70vh]">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Bot size={20} aria-hidden /> {t("assistant.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("assistant.subtitle", { credits: account?.credits ?? 0 })}</p>
      </div>

      {locked ? (
        <div className="rounded-xl border border-border bg-card p-5 text-sm">
          {t("assistant.needsPlus")}{" "}
          <Link to="/pricing" className="text-primary hover:underline">
            {t("account.upgrade")}
          </Link>
        </div>
      ) : (
        <>
          <div className="flex-1 space-y-4">
            {turns.length === 0 && (
              <div className="grid gap-2">
                {EXAMPLES.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => void send(t(key))}
                    className="text-left rounded-lg border border-border bg-card px-4 py-3 text-sm hover:border-primary/50"
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            )}
            {turns.map((turn, i) => (
              <div key={i} className={turn.role === "user" ? "flex justify-end" : ""}>
                <div className={turn.role === "user" ? "max-w-[85%] rounded-2xl bg-primary text-primary-foreground px-4 py-2" : "space-y-2"}>
                  {turn.steps && turn.steps.length > 0 && (
                    <details className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
                      <summary className="cursor-pointer text-muted-foreground flex items-center gap-1">
                        <Wrench size={12} aria-hidden /> {t("assistant.steps", { count: turn.steps.length })}
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {turn.steps.map((s, j) => (
                          <li key={j}>
                            <span className={s.ok ? "text-foreground" : "text-destructive"}>{s.tool}</span>
                            <span className="text-muted-foreground"> — {s.summary.slice(0, 160)}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <p className="whitespace-pre-wrap">{turn.content}</p>
                  {turn.credits !== undefined && <p className="text-[11px] text-muted-foreground">{t("assistant.cost", { credits: turn.credits })}</p>}
                </div>
              </div>
            ))}
            {busy && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={14} className="animate-spin" /> {t("assistant.thinking")}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div ref={bottom} />
          </div>
          <form onSubmit={submit} className="sticky bottom-20 md:bottom-4 flex gap-2 items-end">
            <Textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder={t("assistant.placeholder")}
              aria-label={t("assistant.placeholder")}
            />
            <Button type="submit" disabled={busy || !input.trim()} aria-label={t("assistant.send")}>
              <Send size={16} />
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
