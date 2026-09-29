import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import zh from "./locales/zh.json";

const STORAGE_KEY = "openkoto.lang";

function initialLanguage(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return saved;
  } catch {
    // Storage can be unavailable (private mode); fall through to the browser language.
  }
  const lang = navigator.language.toLowerCase();
  if (lang.startsWith("zh")) return "zh";
  if (lang.startsWith("ja")) return "ja";
  return "en";
}

const startLanguage = initialLanguage();

void i18n.use(initReactI18next).init({
  resources: { zh: { translation: zh }, en: { translation: en }, ja: { translation: ja } },
  lng: startLanguage,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

// Keep <html lang> in step with the UI language (screen readers, fonts, hyphenation).
function syncHtmlLang(lang: string): void {
  if (typeof document !== "undefined") document.documentElement.lang = lang === "zh" ? "zh-CN" : lang;
}
syncHtmlLang(startLanguage);
i18n.on("languageChanged", syncHtmlLang);

export function setLanguage(lang: string): void {
  void i18n.changeLanguage(lang);
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Ignore: the choice just won't persist.
  }
}

export default i18n;
