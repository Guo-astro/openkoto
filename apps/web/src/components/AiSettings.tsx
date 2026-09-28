import { Settings2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { loadByok, saveByok, setTargetLanguage, targetLanguage, type AiMode } from "../lib/ai";
import { useSession } from "../lib/session";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const TARGETS = ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es"];

/** Chooses hosted AI (credits) vs. the user's own key, plus the translation target language. */
export function useAiMode(): { mode: AiMode | null; target: string } {
  const { account } = useSession();
  const byok = loadByok();
  const hosted = !!account && account.credits > 0;
  return { mode: hosted ? "hosted" : byok ? "byok" : null, target: targetLanguage() };
}

export function AiSettings({ onChange }: { onChange?: () => void }) {
  const { t } = useTranslation();
  const { account } = useSession();
  const [open, setOpen] = useState(false);
  const existing = loadByok();
  const [form, setForm] = useState({
    baseUrl: existing?.baseUrl ?? "https://api.deepseek.com/v1",
    apiKey: existing?.apiKey ?? "",
    model: existing?.model ?? "deepseek-chat",
  });
  const [target, setTarget] = useState(targetLanguage());

  const save = (e: FormEvent) => {
    e.preventDefault();
    saveByok(form.apiKey.trim() ? { ...form, apiKey: form.apiKey.trim() } : null);
    setTargetLanguage(target);
    setOpen(false);
    onChange?.();
  };

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Settings2 size={16} /> {t("ai.settings")}
      </Button>
      {open && (
        <form onSubmit={save} className="basis-full rounded-xl border border-border bg-card p-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            {account && account.credits > 0 ? t("ai.hostedActive", { credits: account.credits }) : t("ai.hostedInactive")}
          </p>
          <label className="block text-sm">
            {t("ai.target")}
            <select className="mt-1 block h-9 w-full rounded-md border border-input bg-background px-3" value={target} onChange={(e) => setTarget(e.target.value)}>
              {TARGETS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("ai.byok")}</legend>
            <p className="text-xs text-muted-foreground">{t("ai.byokHint")}</p>
            <Input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" aria-label="Base URL" />
            <Input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="deepseek-chat" aria-label="Model" />
            <Input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-…" aria-label="API key" autoComplete="off" />
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit">{t("common.save")}</Button>
          </div>
        </form>
      )}
    </>
  );
}
