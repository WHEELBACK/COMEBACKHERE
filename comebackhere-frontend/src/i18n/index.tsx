/**
 * Lightweight i18n layer for COMEBACKHERE frontend.
 *
 * - Supports typed key paths (dot-notation) derived from the `en` dictionary.
 * - Falls back to the English string when a translation key is missing.
 * - Warns in development when a key is missing in the active language.
 * - Supports simple `{{placeholder}}` interpolation.
 *
 * Usage:
 *   const t = useT()
 *   t("invoicePayment.title")
 *   t("wallet.connected", { address: "GABCD...1234" })
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import en from "./en"
import type { Dictionary } from "./types"

// ---------------------------------------------------------------------------
// Supported locales
// ---------------------------------------------------------------------------

export type Locale = "en"

export const SUPPORTED_LOCALES: Locale[] = ["en"]

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
}

const DEFAULT_LOCALE: Locale = "en"

// ---------------------------------------------------------------------------
// Type-safe key path helper
// ---------------------------------------------------------------------------

type Paths<T, Prefix extends string = ""> = {
  [K in keyof T]: T[K] extends Record<string, unknown>
    ? Paths<T[K], `${Prefix}${K & string}.`>
    : `${Prefix}${K & string}`
}[keyof T]

/** All valid dot-notation key paths for the Dictionary. */
export type I18nKey = Paths<Dictionary>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up a nested value by dot-notation path.
 * Returns `undefined` if the path does not exist.
 */
function getByPath(obj: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split(".")
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return typeof current === "string" ? current : undefined
}

/**
 * Replace `{{key}}` placeholders in a string with values from `params`.
 */
function interpolate(
  template: string,
  params?: Record<string, string | number>
): string {
  if (!params) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    params[key] != null ? String(params[key]) : `{{${key}}}`
  )
}

// ---------------------------------------------------------------------------
// Dictionaries store
// ---------------------------------------------------------------------------

const dictionaries: Record<Locale, Dictionary> = {
  en,
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: I18nKey, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface I18nProviderProps {
  children: ReactNode
  /**
   * Initial locale. Defaults to the browser language if supported, otherwise
   * falls back to `"en"`.
   */
  initialLocale?: Locale
}

function detectLocale(): Locale {
  const browserLang = navigator.language.split("-")[0] as Locale
  return SUPPORTED_LOCALES.includes(browserLang) ? browserLang : DEFAULT_LOCALE
}

const STORAGE_KEY = "cbh_locale"

export function I18nProvider({ children, initialLocale }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (initialLocale) return initialLocale
    const stored = localStorage.getItem(STORAGE_KEY) as Locale | null
    if (stored && SUPPORTED_LOCALES.includes(stored)) return stored
    return detectLocale()
  })

  useEffect(() => {
    document.documentElement.setAttribute("lang", locale)
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    if (!SUPPORTED_LOCALES.includes(next)) return
    localStorage.setItem(STORAGE_KEY, next)
    setLocaleState(next)
  }, [])

  const t = useCallback(
    (key: I18nKey, params?: Record<string, string | number>): string => {
      const dict = dictionaries[locale] as unknown as Record<string, unknown>
      const enDict = dictionaries.en as unknown as Record<string, unknown>

      const translated = getByPath(dict, key)
      if (translated !== undefined) {
        return interpolate(translated, params)
      }

      // Fall back to English with a dev warning
      if (import.meta.env.DEV) {
        console.warn(`[i18n] Missing key "${key}" for locale "${locale}". Falling back to "en".`)
      }

      const fallback = getByPath(enDict, key)
      if (fallback !== undefined) {
        return interpolate(fallback, params)
      }

      // Key is missing from en too — return the key itself as last resort
      if (import.meta.env.DEV) {
        console.error(`[i18n] Key "${key}" is missing from the "en" dictionary. This is a bug.`)
      }
      return key
    },
    [locale]
  )

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns the `t()` translation function bound to the active locale.
 *
 * @example
 *   const t = useT()
 *   <h1>{t("app.title")}</h1>
 *   <p>{t("wallet.connected", { address: "GABCD...1234" })}</p>
 */
export function useT(): (
  key: I18nKey,
  params?: Record<string, string | number>
) => string {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    throw new Error("useT must be used inside <I18nProvider>")
  }
  return ctx.t
}

/**
 * Returns the full i18n context: locale, setLocale, and t.
 */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    throw new Error("useI18n must be used inside <I18nProvider>")
  }
  return ctx
}
