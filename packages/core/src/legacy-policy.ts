export type LegacyScan = (runtimeRoot: string) => Promise<{ count: number; error?: string }>
export type LegacyResult = { count: number; error?: string; not_applicable?: boolean }

/**
 * Política por plataforma del bloqueo por gateways heredados de una actualización silenciosa.
 *
 * - macOS: el escaneo es obligatorio y necesita la raíz del runtime versionado; sin escáner o sin raíz la respuesta
 *   es «desconocido» (la compuerta no concede).
 * - Windows y Linux: no existe runtime versionado, así que el escaneo no aplica y el bloqueo es `count: 0` de forma
 *   explícita. Windows se protege antes del drenaje con `bridgesAtRisk()` (NSIS cierra los procesos del directorio);
 *   Linux (AppImage) reemplaza el archivo por rename y no mata procesos ya mapeados.
 */
export function legacyGatewaysFor(platform: NodeJS.Platform, scan: LegacyScan | undefined, runtimeRoot: string): (() => Promise<LegacyResult>) | undefined {
  if (platform === "darwin") return scan && runtimeRoot ? () => scan(runtimeRoot) : undefined
  // Sólo estas dos plataformas están decididas como «no aplica»; cualquier otra queda desconocida (fail-closed).
  if (platform === "win32" || platform === "linux") return async () => ({ count: 0, not_applicable: true })
  return undefined
}
