import { useI18n, SUPPORTED_LOCALES, LOCALE_LABELS, type Locale } from "../i18n"

/**
 * LanguageSwitcher — renders a compact <select> that lets users switch the
 * active locale.  Designed to sit in the app header alongside the wallet bar.
 */
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n()

  if (SUPPORTED_LOCALES.length <= 1) {
    // No point rendering a picker when only one locale is available.
    return null
  }

  return (
    <label className="language-switcher" aria-label={t("app.language")}>
      <span className="sr-only">{t("app.language")}</span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        className="language-switcher__select"
        aria-label={t("app.language")}
      >
        {SUPPORTED_LOCALES.map((loc) => (
          <option key={loc} value={loc}>
            {LOCALE_LABELS[loc]}
          </option>
        ))}
      </select>
    </label>
  )
}
