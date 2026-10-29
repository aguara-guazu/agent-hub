import { useLanguagePreference } from "./language"
import { useT } from "./useT"
import type { LanguagePreference } from "./types"

const OPTIONS: ReadonlyArray<{ value: LanguagePreference; lang?: string }> = [
  { value: "es", lang: "es" },
  { value: "en", lang: "en" },
  { value: "auto" },
]

/**
 * Segmentado de idioma para Ajustes › General (`.seg` de ah.css). Aplica al instante y guarda la preferencia.
 * Los nombres de idioma se muestran en su propio idioma; «Automático» sigue el idioma del sistema.
 */
export function LanguageSelect() {
  const { t } = useT("common")
  const [preference, setPreference] = useLanguagePreference()
  return (
    <div className="seg" role="group" aria-label={t("language.label")}>
      {OPTIONS.map(option => (
        <button
          key={option.value}
          type="button"
          lang={option.lang}
          aria-pressed={preference === option.value}
          onClick={() => setPreference(option.value)}
        >
          {t(`language.${option.value}`)}
        </button>
      ))}
    </div>
  )
}
