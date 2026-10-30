/**
 * Lo que un cliente tiene instalado por fuera del hub: entradas de MCP server distintas de `hub`
 * en su archivo de configuración y carpetas de skills que el manifiesto del daemon no registra
 * como propias. Solo nombres y rutas: comandos, URLs, encabezados y variables no viajan porque
 * pueden contener secretos.
 */

/** Topes del inventario que manda el daemon y que el core acepta. */
export const UNMANAGED_MAX_ITEMS = 200
export const UNMANAGED_MAX_NAME = 200
export const UNMANAGED_MAX_PATH = 1024

export interface UnmanagedServer {
  /** Clave de la entrada en el archivo del cliente. */
  name: string
  /** Archivo donde está declarada. */
  path: string
}

export interface UnmanagedSkill {
  /** Nombre de la carpeta de la skill. */
  slug: string
  /** Carpeta o enlace dentro de la raíz de skills del cliente. */
  path: string
  /** La entrada es un enlace simbólico (por ejemplo, a `~/.agents/skills`). */
  linked: boolean
}

export interface UnmanagedInventoryError {
  path: string
  reason: string
}

/** Campo `unmanaged` de `POST /api/sync/report`. */
export interface UnmanagedInventory {
  checked_at: string
  servers: UnmanagedServer[]
  skills: UnmanagedSkill[]
  /** Archivos o carpetas que no se pudieron leer; el inventario puede estar incompleto. */
  errors: UnmanagedInventoryError[]
  /** Se cortó en UNMANAGED_MAX_ITEMS. */
  truncated: boolean
}

/**
 * Campo opcional `unmanaged` de cada cliente en `GET /api/local/overview`. `null` cuando su daemon
 * todavía no reportó inventario (por ejemplo, una versión anterior). `catalog_*_id` apunta a un
 * recurso del hub con el mismo slug, si existe: está en el catálogo pero el cliente lo carga por su cuenta.
 */
export interface LocalUnmanaged {
  checked_at: string
  servers: Array<UnmanagedServer & { catalog_server_id: string | null }>
  skills: Array<UnmanagedSkill & { catalog_skill_id: string | null }>
  errors: UnmanagedInventoryError[]
  truncated: boolean
}
