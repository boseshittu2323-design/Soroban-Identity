import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import es from "./locales/es.json";

const SUPPORTED_LOCALES: Record<string, object> = {
  en: { translation: en },
  es: { translation: es },
};

const STORAGE_KEY = "lang";

i18n.use(initReactI18next).init({
  resources: SUPPORTED_LOCALES,
  lng: localStorage.getItem(STORAGE_KEY) ?? "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function setLocale(locale: string): void {
  const resolved = SUPPORTED_LOCALES[locale] ? locale : "en";
  localStorage.setItem(STORAGE_KEY, resolved);
  i18n.changeLanguage(resolved);
}

export default i18n;
