import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../../lib/api"

/** Contrato de `/memory/sharing/call` (packages/memory/src/sharing/routes.ts), igual que pages/MemorySharing.tsx. */
export type SharingRole = "owner" | "maintainer" | "reader"
export interface SharingIdentity { id: string; name: string; signing: string; encryption: string }
export interface SharingMember { identity: SharingIdentity; role: SharingRole; invite: boolean; revoked: boolean; expires_at: string | null }
export interface SharedProject { id: string; title: string; enabled: boolean; conflict: string | null }
export interface NetworkSettings { enabled: boolean; bootstrap: string[]; bind_host?: string }
export interface SharingStatus {
  identity: SharingIdentity
  network: { settings: NetworkSettings; connected_peers: number; error: string | null }
  projects: SharedProject[]
}

/** Misma clave que pages/MemorySharing.tsx para compartir la caché con las vistas que aún lo usan. */
export const SHARING_KEY = ["sharing"] as const

export const sharingCall = <T = unknown>(input: unknown) => api.post<T>("/memory/sharing/call", input)

export function useSharingStatus(enabled = true) {
  return useQuery({ queryKey: SHARING_KEY, queryFn: () => sharingCall<SharingStatus>({ operation: "status" }), refetchInterval: 5000, enabled })
}

/** Miembros de un proyecto compartido (`shared_status` de la memoria). */
export function useSharedMembers(projectId: string) {
  return useQuery({
    queryKey: ["memory", "shared_status", { project_id: projectId }],
    queryFn: () => api.post<{ members: SharingMember[] }>("/memory/call", { operation: "shared_status", input: { project_id: projectId } }),
  })
}

/** Operación de compartición; invalida el estado y la memoria. Los errores los maneja quien llama. */
export function useSharingAction<T = unknown>(onError: (error: unknown) => void, onSuccess?: (value: T, input: any) => void) {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (input: unknown) => sharingCall<T>(input),
    onSuccess: (value, input) => {
      void cache.invalidateQueries({ queryKey: SHARING_KEY })
      void cache.invalidateQueries({ queryKey: ["memory"] })
      onSuccess?.(value, input)
    },
    onError,
  })
}

export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: "application/json" }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Nombre de archivo seguro a partir del título del proyecto (mismo criterio que MemorySharing). */
export function projectFilename(title: string): string {
  return `${title.replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 80) || "proyecto"}.hubproject`
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export function isIpv4(value: string): boolean {
  return IPV4.test(value.trim())
}

/** `host:puerto` separados por coma, como los guarda la red. */
export function parseBootstrap(value: string): string[] {
  return value.split(",").map(item => item.trim()).filter(Boolean)
}

/** Acorta un identificador largo por el medio (regla L7). */
export function shortId(value: string, head = 8, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value
}
