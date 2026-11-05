/**
 * Identidad de un proceso para la parada coordinada: PID más hora de inicio. Tres estados, porque la ausencia de dato no es una salida:
 * `string` = el proceso vive con esa hora de inicio, `null` = se comprobó que ya no existe, `undefined` = no se pudo inspeccionar.
 * En macOS y Linux sale de `ps` (sin cambios de formato, para no invalidar identidades ni journales existentes). En Windows, de
 * `inspectNativeProcess` de @agenthub/gateway (CIM), que distingue «no existe» de «la consulta falló o expiró».
 */
import { inspectNativeProcess } from "@agenthub/gateway"
import { processStartTime } from "./update-rollback.js"

export type CoreIdentity = string | null | undefined

export interface IdentityDeps {
  platform?: NodeJS.Platform
  inspect?: (pid: number) => Promise<{ started: string } | null | undefined>
  posix?: (pid: number) => Promise<string | null>
}

export async function coreStartTime(pid: number, deps: IdentityDeps = {}): Promise<CoreIdentity> {
  if ((deps.platform ?? process.platform) !== "win32") return await (deps.posix ?? processStartTime)(pid)
  try {
    const live = await (deps.inspect ?? inspectNativeProcess)(pid)
    if (live === null) return null
    return typeof live?.started === "string" && live.started ? live.started : undefined
  } catch {
    return undefined
  }
}
