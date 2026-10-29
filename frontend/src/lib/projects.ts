import { useQuery } from "@tanstack/react-query"
import type { EntitySummary } from "@agenthub/shared"
import type status from "../i18n/locales/es/status"
import type { ChipTone } from "../components/ui"
import { memoryCall, type MemoryEntity, type Page } from "./memory"

/** Etapas tal como llegan en `data.status`; las claves coinciden con `status.stage`. */
export type Stage = keyof typeof status.stage
export type Relation = keyof typeof status.relation

/** Etapas que se ofrecen al editar; `active` y `maintenance` solo se leen (alias de API). */
export const STAGE_CHOICES = ["discovery", "presales", "poc", "delivery", "support", "paused", "completed"] as const satisfies readonly Stage[]

/** Relaciones que se pueden crear a mano desde «Vincular». */
export const RELATION_CHOICES = ["related", "project", "company", "participant", "meeting_document", "derived_from"] as const satisfies readonly Relation[]

const STAGE_TONE: Record<Stage, ChipTone> = {
  discovery: "info", presales: "info", poc: "info",
  delivery: "ok", active: "ok", support: "ok", maintenance: "ok",
  paused: "off", completed: "off",
}

export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && value in STAGE_TONE
}

export function isRelation(value: unknown): value is Relation {
  return typeof value === "string" && (RELATION_CHOICES as readonly string[]).includes(value) || value === "belongs_to"
}

/** Proyectos sin etapa se tratan como descubrimiento, igual que al crearlos. */
export function projectStage(project: MemoryEntity): Stage {
  return isStage(project.data.status) ? project.data.status : "discovery"
}

export function stageTone(stage: Stage): ChipTone {
  return STAGE_TONE[stage]
}

/** Último momento con actividad conocida del proyecto. */
export function projectActivity(project: MemoryEntity): string {
  return project.updated_at ?? project.created_at
}

const PROJECT_PAGE = 200
const PROJECT_CAP = 2000

export type ProjectWithSummary = MemoryEntity & { summary?: EntitySummary }

/** Todos los proyectos (hasta 2000) con su resumen (empresa, contenido por tipo, personas) calculado en lote por página.
 *  El filtrado, los contadores y el orden se hacen en el cliente. */
export function useAllProjects() {
  return useQuery({
    queryKey: ["memory", "projects-all"],
    queryFn: async () => {
      const items: ProjectWithSummary[] = []
      let total = 0
      do {
        const page = await memoryCall<Page<ProjectWithSummary>>("list_entities", { kind: "project", include: ["summary"], limit: PROJECT_PAGE, offset: items.length })
        items.push(...page.items)
        total = page.total
        if (page.items.length === 0) break
      } while (items.length < total && items.length < PROJECT_CAP)
      return { items, total }
    },
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  })
}

/** Empresas para resolver `data.company_id` y alimentar los combobox. */
export function useCompanies(enabled = true) {
  return useQuery({
    queryKey: ["memory", "companies-all"],
    queryFn: () => memoryCall<Page<MemoryEntity>>("list_entities", { kind: "company", limit: 200 }),
    enabled,
    staleTime: 15_000,
  })
}

const COUNT_CONCURRENCY = 4
let countsRunning = 0
const countsWaiting: Array<() => void> = []

/** Cola con tope de concurrencia para los conteos: la lista no dispara N consultas a la vez. */
async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (countsRunning >= COUNT_CONCURRENCY) await new Promise<void>(resolve => countsWaiting.push(resolve))
  countsRunning++
  try { return await task() }
  finally { countsRunning--; countsWaiting.shift()?.() }
}

/** Total de contenido vinculado a un proyecto (`limit: 1`, solo `total`); sin sondeo. `enabled` permite pedirlo solo para filas visibles. */
export function useProjectContentCount(projectId: string, kind?: string, enabled = true) {
  return useQuery({
    queryKey: ["memory", "project-count", projectId, kind ?? "all"],
    queryFn: () => limited(() => memoryCall<Page<MemoryEntity>>("list_entities", { project_id: projectId, ...(kind ? { kind } : {}), limit: 1 }).then(page => page.total)),
    staleTime: 30_000,
    enabled,
  })
}

const DAY_MS = 86_400_000

/** R5: relativa hasta 7 días; después, absoluta corta («16 oct»). */
export function listDate(value: string | null | undefined, language: "es" | "en", relative: (value: string) => string): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "—"
  if (Math.abs(Date.now() - date.getTime()) < 7 * DAY_MS) return relative(value)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat(language, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }).format(date)
}

/** Cuerpo de `import_file`: el archivo en base64 sin el prefijo `data:`. */
export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "")
    reader.onerror = () => reject(reader.error ?? new Error("read"))
    reader.readAsDataURL(file)
  })
}

export const MAX_FILE_BYTES = 25_000_000
export const MAX_ARCHIVE_BYTES = 175_000_000

/** «AAAA-MM-DD HH:MM» o «AAAA-MM-DD» en hora local → ISO; `null` si no es válida. Reemplaza al `datetime-local` nativo. */
export function parseLocalDateTime(text: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(text.trim())
  if (!match) return null
  const [, y, m, d, hh = "00", mm = "00"] = match
  const date = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm))
  if (date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d) || Number(hh) > 23 || Number(mm) > 59) return null
  return date.toISOString()
}
