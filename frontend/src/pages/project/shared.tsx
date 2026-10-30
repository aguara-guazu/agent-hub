import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useSearchParams } from "react-router-dom"
import { Chip, useToast } from "../../components/ui"
import { errorKey, useFormat, useT } from "../../i18n"
import { memoryCall, type MemoryEntity } from "../../lib/memory"
import { listDate, stageTone, type Stage } from "../../lib/projects"

/** Texto para la persona a partir de un error de la API (R6). */
export function useErrorText() {
  const { t } = useT("errors")
  return (error: unknown): string => t(errorKey(error))
}

/**
 * Operación de memoria que refresca las consultas `memory*` al terminar.
 * Sin `quiet`, un error se avisa con un toast; con `quiet`, lo muestra quien llama (diálogos con su propio error).
 */
export function useMemoryAction<T = unknown, I = unknown>(operation: string, { quiet = false }: { quiet?: boolean } = {}) {
  const cache = useQueryClient()
  const toast = useToast()
  const text = useErrorText()
  return useMutation({
    mutationFn: (input: I) => memoryCall<T>(operation, input),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["memory"] })
      void cache.invalidateQueries({ queryKey: ["memory-status"] })
    },
    onError: error => { if (!quiet) toast.error(text(error)) },
  })
}

type KindKey = "meeting" | "document" | "note" | "collection" | "decision" | "fact" | "message" | "issue" | "event" | "person" | "company" | "project"
const KINDS = new Set<string>(["meeting", "document", "note", "collection", "fact", "message", "issue", "event", "person", "company", "project"])

/** Etiqueta del tipo de una entidad; los hechos de categoría `decision` se muestran como Decisión. */
export function useKindLabel() {
  const { t } = useT("project")
  return (entity: Pick<MemoryEntity, "kind" | "data">): string => {
    const key: KindKey = entity.kind === "fact" && entity.data?.category === "decision" ? "decision" : KINDS.has(entity.kind) ? entity.kind as KindKey : "note"
    return t(`content.kind.${key}`)
  }
}

export function StageChip({ stage }: { stage: Stage }) {
  const { t } = useT("status")
  return <Chip tone={stageTone(stage)}>{t(`stage.${stage}`)}</Chip>
}

/** Fecha para filas: relativa hasta 7 días, absoluta corta después; la completa va en `title`. */
export function ListDate({ value }: { value: string | null | undefined }) {
  const format = useFormat()
  return <span className="xs t3" title={value ? format.date(value, "datetime") : undefined}>{listDate(value, format.language, format.relative)}</span>
}

/** Fecha de contenido: la del hecho (reunión, documento) si existe, si no la de la última edición. */
export function entityDate(entity: MemoryEntity): string {
  return entity.data?.occurred_at ?? entity.updated_at ?? entity.created_at
}

/** Detalle de una línea para filas de contenido. */
export function entityDetail(entity: MemoryEntity): string | undefined {
  const value = entity.data?.description ?? entity.data?.text ?? entity.data?.email
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : undefined
}

/** `true` bajo 1100 px: se ocultan columnas prescindibles y se apilan columnas laterales. */
export function useNarrow(width = 1100): boolean {
  const query = `(max-width: ${width}px)`
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches === true)
  useEffect(() => {
    const media = window.matchMedia?.(query)
    if (!media) return
    const update = () => setNarrow(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [query])
  return narrow
}

/** Abre otra pestaña o un panel de la ficha a través de la URL (`?tab=`, `?panel=`, `?add=`), sin ampliar las props del contrato. */
export function useProjectNavigation() {
  const [, setParams] = useSearchParams()
  return (values: Record<string, string>) => setParams(current => {
    const next = new URLSearchParams(current)
    for (const [key, value] of Object.entries(values)) next.set(key, value)
    return next
  }, { replace: true })
}
