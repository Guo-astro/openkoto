import { Brain, Check, Smartphone } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * First-screen product sketch: a reader page with one highlighted word, the word card that
 * pops up for it (meaning, grammar of the sentence, cultural context), and the review / sync
 * chips that follow. It shows the core loop
 * (read → tap a word → save → review) in the landing palette, so visitors get what the app
 * does before reading any copy. Text comes from `landing.mock.*` so each UI language sees a
 * foreign-language page (Japanese for zh/en, English for ja).
 */
export function HeroMock({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={className} aria-hidden="true">
      <div className="relative mx-auto w-full max-w-[520px] pb-6 pt-5">
        {/* sync chip */}
        <div className="lp-mock-chip absolute -top-1 right-2 z-10 bg-mist sm:-right-3">
          <Smartphone size={14} strokeWidth={1.6} />
          {t("landing.mock.sync")}
        </div>

        {/* reader window */}
        <div className="rounded-[22px] bg-paper p-5 text-left shadow-lg ring-1 ring-line sm:p-7">
          <div className="flex items-center justify-between gap-4">
            <p className="lp-tiny lp-muted truncate">{t("landing.mock.chapter")}</p>
            <div className="h-1 w-20 shrink-0 overflow-hidden rounded-full bg-line">
              <div className="h-full w-[42%] rounded-full bg-foreground/60" />
            </div>
          </div>
          <p lang={t("landing.mock.lang")} className="lp-mock-text mt-4 text-[17px] leading-[2] sm:text-[18px]">
            {t("landing.mock.before")}
            <mark className="lp-mock-word">{t("landing.mock.word")}</mark>
            {t("landing.mock.after")}
          </p>

          {/* word card */}
          <div className="lp-mock-pop relative mt-4 rounded-2xl bg-background p-4 ring-1 ring-line sm:ml-10">
            <span className="absolute -top-[7px] left-10 size-3 rotate-45 bg-background ring-1 ring-line [clip-path:polygon(0_0,100%_0,0_100%)]" />
            <div className="flex items-baseline gap-2">
              <span lang={t("landing.mock.lang")} className="text-[20px] leading-none">
                {t("landing.mock.word")}
              </span>
              <span className="lp-muted text-[14px]">{t("landing.mock.reading")}</span>
            </div>
            <p className="mt-2 text-[15px] leading-snug">
              <span className="lp-muted mr-1.5">{t("landing.mock.pos")}</span>
              {t("landing.mock.meaning")}
            </p>
            {/* the deeper AI notes: grammar of the sentence, cultural context of the word */}
            <dl className="mt-3 space-y-2 border-t border-line pt-3 text-[14px] leading-snug">
              <div className="lp-mock-note flex gap-2.5">
                <dt className="h-fit shrink-0 rounded-full bg-mist px-2 py-0.5 text-[12px]">{t("landing.mock.grammarLabel")}</dt>
                <dd>{t("landing.mock.grammar")}</dd>
              </div>
              <div className="lp-mock-note flex gap-2.5">
                <dt className="h-fit shrink-0 rounded-full bg-clay px-2 py-0.5 text-[12px]">{t("landing.mock.cultureLabel")}</dt>
                <dd>{t("landing.mock.culture")}</dd>
              </div>
            </dl>
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-honey px-3 py-1 text-[13px]">
              <Check size={13} strokeWidth={2} />
              {t("landing.mock.added")}
            </div>
          </div>
        </div>

        {/* review chip */}
        <div className="lp-mock-chip lp-mock-review absolute -bottom-1 left-2 z-10 bg-sage sm:-left-4">
          <Brain size={14} strokeWidth={1.6} />
          {t("landing.mock.review")}
        </div>
      </div>
    </div>
  );
}
