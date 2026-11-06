import type { ConsumptionEvent, LinkCursor } from "@agenthub/shared"
import type { DaemonState } from "../state.js"

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"]

/** Daemon-only client for the consumption routes. Same local Hub and token rules as InstalledQuotaClient. */
export class ConsumptionClient {
  constructor(private readonly state: DaemonState, readonly agentId: string) {}

  usageEnabled(): boolean {
    const servers = this.state.loadSnapshot(this.agentId)?.["servers"] as { tools?: { name: string }[] }[] | undefined
    return !!servers?.some(server => server.tools?.some(tool => tool.name === "usage_status"))
  }

  private localUrl(path: string): { url: URL; token: string } {
    const credentials = this.state.loadCredentials()
    if (!credentials) throw new Error("usage_not_enrolled")
    const url = new URL(path, credentials.controlPlaneUrl)
    if (!LOCAL_HOSTS.includes(url.hostname)) throw new Error("usage_requires_local_hub")
    return { url, token: credentials.token }
  }

  /** The route derives the CLI from agent_id and rejects extra query parameters. */
  async links(): Promise<LinkCursor[]> {
    if (!this.usageEnabled()) throw new Error("usage_disabled")
    const { url, token } = this.localUrl("/api/memory/usage/consumption/links")
    url.searchParams.set("agent_id", this.agentId)
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error(`usage_http_${response.status}`)
    const body = (await response.json()) as { items?: LinkCursor[] }
    return body.items ?? []
  }

  async ingest(events: ConsumptionEvent[], cursor?: { hub_session_id: string; native_session_id: string; file_path: string | null; file_offset: number; scan_state: unknown }): Promise<void> {
    if (!this.usageEnabled()) throw new Error("usage_disabled")
    const { url, token } = this.localUrl("/api/memory/usage/consumption/ingest")
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: this.agentId, events, ...(cursor ? { cursor } : {}) }),
      signal: AbortSignal.timeout(20000),
    })
    if (!response.ok) throw new Error(`usage_http_${response.status}`)
  }
}
