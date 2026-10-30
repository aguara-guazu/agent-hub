import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"

export type Role = "owner" | "maintainer" | "reader"
export const ROLES: readonly Role[] = ["owner", "maintainer", "reader"]
export interface Identity { id: string; name: string; signing: string; encryption: string }
export interface Member { identity: Identity; role: Role; invite: boolean; revoked: boolean; expires_at: string | null }
export interface PeerProgress { project_id: string; member_id: string; total: number; confirmed: number; state: "waiting" | "syncing" | "synced" }
export interface SharingStatus {
  identity: Identity
  network: { settings: { enabled: boolean; bootstrap: string[]; bind_host?: string }; connected_peers: number; peers?: PeerProgress[]; error: string | null }
  projects: { id: string; title: string; enabled: boolean; conflict: string | null }[]
}
export interface SharedDetail { members: Member[]; conflict: string | null }

/** Administración P2P del hub local (no pasa por `/memory/call`). Misma clave de caché que Ajustes › Colaboración y red. */
export const sharingCall = <T = unknown,>(input: unknown) => api.post<T>("/memory/sharing/call", input)

export function useSharingStatus() {
  return useQuery({ queryKey: ["sharing"], queryFn: () => sharingCall<SharingStatus>({ operation: "status" }), refetchInterval: 5000 })
}

export function useSharingAction<T = unknown>() {
  const cache = useQueryClient()
  return useMutation({
    mutationFn: (input: unknown) => sharingCall<T>(input),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ["sharing"] })
      void cache.invalidateQueries({ queryKey: ["memory"] })
    },
  })
}

/** Vigente: no revocado y con el plazo de acceso sin vencer (los propietarios no vencen). */
export const isActive = (member: Member) => !member.revoked && (!member.expires_at || Date.parse(member.expires_at) > Date.now())

/** `true` si la sesión local puede invitar: propietario, o con permiso de invitar y acceso vigente. */
export function mayInvite(me: Member | undefined): boolean {
  if (!me || me.revoked) return false
  return me.role === "owner" || (me.invite && !!me.expires_at && Date.parse(me.expires_at) > Date.now())
}
