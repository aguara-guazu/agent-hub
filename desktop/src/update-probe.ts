/**
 * Sonda de salud no mutante del MCP de memoria: un `tools/list` autenticado con la misma credencial que usan los
 * gateways (no el token de sesión del escritorio). Sin Electron: red y disco son inyectables.
 */
import { readFile } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { join } from "node:path"

/** Archivo donde core guarda la credencial MCP de memoria, bajo `<stateDir>/memory/secrets`. */
export function memoryCredentialPath(stateDir: string): string {
  return join(stateDir, "memory", "secrets", "memory-mcp")
}

export interface ProbeDeps {
  baseUrl: string
  credentialPath: string
  timeoutMs: number
  readFileFn?: (path: string) => Promise<string>
}

/**
 * `true` sólo si un cliente MCP real (`initialize` + `tools/list` por Streamable HTTP, como hacen los gateways)
 * obtiene al menos una herramienta. Nunca lanza, nunca llama a una herramienta y nunca escribe estado.
 */
export async function probeMemoryMcp(deps: ProbeDeps): Promise<boolean> {
  const client = new Client({ name: "agenthub-update-probe", version: "1.0.0" })
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), deps.timeoutMs)
  try {
    const credential = (await (deps.readFileFn ?? ((path) => readFile(path, "utf8")))(deps.credentialPath)).trim()
    if (!credential) return false
    const transport = new StreamableHTTPClientTransport(new URL(`${deps.baseUrl}/api/memory/mcp`), { requestInit: { headers: { Authorization: credential }, signal: abort.signal } })
    await client.connect(transport as Transport, { signal: abort.signal, timeout: deps.timeoutMs })
    const { tools } = await client.listTools(undefined, { signal: abort.signal, timeout: deps.timeoutMs })
    return Array.isArray(tools) && tools.length > 0
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    await client.close().catch(() => undefined)
  }
}
