/**
 * UI language (EN default + TR). `strings` always reads the active dictionary at access time,
 * so non-React code (commands, notifications) follows a language switch too; React components
 * call `useStrings()` so they re-render when it changes. The choice ("en" | "tr" | "system")
 * is a frontend preference kept in the `ui` slice of `state.json`.
 */
import { create } from "zustand";
import { saveStateSlice, type PersistedState } from "../../lib/ipc";
import { en, type Strings } from "./en";
import { tr } from "./tr";

export type { Strings } from "./en";
export type Language = "en" | "tr";
export type LanguagePreference = Language | "system";

export const LANGUAGES: readonly Language[] = ["en", "tr"];
const DICTIONARIES: Record<Language, Strings> = { en, tr };
const LOCALES: Record<Language, string> = { en: "en-US", tr: "tr-TR" };
const STATE_KEY = "ui";

/** "system" follows the OS/WebView language list: Turkish if it comes first among ours, else English. */
export function resolveLanguage(preference: LanguagePreference, systemLanguages: readonly string[] = systemLocales()): Language {
  if (preference !== "system") return preference;
  for (const tag of systemLanguages) {
    const base = tag.toLowerCase().split("-")[0];
    if (base === "tr") return "tr";
    if (base === "en") return "en";
  }
  return "en";
}

function systemLocales(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

function isPreference(value: unknown): value is LanguagePreference {
  return value === "en" || value === "tr" || value === "system";
}

interface I18nState {
  preference: LanguagePreference;
  language: Language;
  setPreference: (preference: LanguagePreference) => void;
}

export const useI18nStore = create<I18nState>((set) => ({
  preference: "system",
  language: resolveLanguage("system"),
  setPreference: (preference) => {
    set({ preference, language: resolveLanguage(preference) });
    if (typeof document !== "undefined") document.documentElement.lang = resolveLanguage(preference);
    void saveStateSlice(STATE_KEY, { language: preference }).catch(() => {});
  },
}));

/** `main.tsx` calls this with the loaded `state.json` before the first render. */
export function hydrateLanguage(state: PersistedState): void {
  const ui = state[STATE_KEY];
  const saved = typeof ui === "object" && ui !== null ? (ui as Record<string, unknown>).language : undefined;
  const preference = isPreference(saved) ? saved : "system";
  const language = resolveLanguage(preference);
  useI18nStore.setState({ preference, language });
  if (typeof document !== "undefined") document.documentElement.lang = language;
}

export function currentLanguage(): Language {
  return useI18nStore.getState().language;
}

/** BCP 47 locale of the active language, for `Intl` formatting. */
export function currentLocale(): string {
  return LOCALES[currentLanguage()];
}

/** The dictionary for one language (tests, language pickers). */
export function dictionary(language: Language): Strings {
  return DICTIONARIES[language];
}

/** Live view of the active dictionary (see the module comment). */
export const strings: Strings = new Proxy({} as Strings, {
  get: (_target, key) => (DICTIONARIES[currentLanguage()] as unknown as Record<PropertyKey, unknown>)[key],
  has: (_target, key) => key in DICTIONARIES[currentLanguage()],
  ownKeys: () => Reflect.ownKeys(DICTIONARIES[currentLanguage()]),
  getOwnPropertyDescriptor: (_target, key) => {
    const value = (DICTIONARIES[currentLanguage()] as unknown as Record<PropertyKey, unknown>)[key];
    return value === undefined ? undefined : { value, enumerable: true, configurable: true };
  },
});

/** Strings for React components: re-renders the caller when the language changes. */
export function useStrings(): Strings {
  useI18nStore((s) => s.language);
  return strings;
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentLocale(), options).format(value);
}

export function formatDateTime(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(currentLocale(), options).format(value);
}

/** Compact token counts per DESIGN_SYSTEM §10 (`312k`, `1.24 M`). */
export function formatTokens(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${formatNumber(value / 1_000_000, { maximumFractionDigits: 2 })} M`;
  }
  if (Math.abs(value) >= 1_000) return `${formatNumber(Math.round(value / 1_000))}k`;
  return formatNumber(value);
}

export function formatCurrencyUsd(value: number): string {
  return new Intl.NumberFormat(currentLocale(), { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(value);
}

export function formatPercent(fraction: number): string {
  return new Intl.NumberFormat(currentLocale(), { style: "percent", maximumFractionDigits: 0 }).format(fraction);
}
