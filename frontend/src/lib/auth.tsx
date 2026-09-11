/** Sesion de la consola web.
 *
 *  Un solo lugar sabe si hay usuario: este contexto. El JWT vive en localStorage
 *  a traves de `setToken` de lib/api; ningun componente lo lee por su cuenta.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLocation } from 'react-router-dom'

import { ApiError, api, getToken, setToken } from './api'
import type { User } from './types'

/** Respuesta de POST /auth/login. */
export interface LoginResponse {
  access_token: string
  token_type: string
  user: User
}

export interface AuthValue {
  user: User | null
  /** True mientras se resuelve la sesion inicial contra GET /auth/me.
   *  Las rutas protegidas no deben decidir nada hasta que sea false. */
  loading: boolean
  /** org_role admin u owner. Es la unica compuerta de UI para lo administrativo;
   *  la de verdad la aplica el backend. */
  isAdmin: boolean
  login: (email: string, password: string) => Promise<User>
  logout: () => void
  /** Vuelve a pedir /auth/me. Util despues de cambiar squads o rol. */
  reload: () => Promise<void>
}

const AuthContext = createContext<AuthValue | null>(null)

function computeIsAdmin(user: User | null): boolean {
  return user !== null && (user.org_role === 'admin' || user.org_role === 'owner')
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState<boolean>(() => getToken() !== null || Boolean(window.agentHub) || new URLSearchParams(window.location.search).has('sso_token'))
  const queryClient = useQueryClient()
  const location = useLocation()

  const fetchMe = useCallback(async (): Promise<User | null> => {
    if (getToken() === null && window.agentHub) {
      try { setToken(await window.agentHub.getSession()) } catch { return null }
    }
    if (getToken() === null) return null
    try {
      return await api.get<User>('/auth/me')
    } catch (error) {
      // 401 aca solo significa token vencido o revocado: no es una falla que reportar.
      if (!(error instanceof ApiError && error.status === 401)) {
        console.warn('No se pudo recuperar la sesion', error)
      }
      setToken(null)
      return null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const url = new URL(window.location.href)
    const token = url.searchParams.get('sso_token')
    if (token) {
      setToken(token)
      url.searchParams.delete('sso_token')
      window.history.replaceState(null, '', url.pathname + url.search + url.hash)
    }
    if (getToken() === null && !window.agentHub) {
      setLoading(false)
      return
    }
    void fetchMe().then((me) => {
      if (cancelled) return
      setUser(me)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [fetchMe])

  // lib/api borra el token ante cualquier 401 y manda el hash a #/login. Cuando eso
  // pasa, la sesion en memoria queda huerfana: la bajamos al primer cambio de ruta.
  useEffect(() => {
    if (user !== null && getToken() === null) setUser(null)
  }, [location.pathname, user])

  const login = useCallback(
    async (email: string, password: string): Promise<User> => {
      const response = await api.post<LoginResponse>('/auth/login', { email, password })
      setToken(response.access_token)
      // La cache anterior es de otra persona: descartarla antes de mostrar nada.
      queryClient.clear()
      setUser(response.user)
      setLoading(false)
      return response.user
    },
    [queryClient],
  )

  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
    queryClient.clear()
  }, [queryClient])

  const reload = useCallback(async () => {
    setUser(await fetchMe())
  }, [fetchMe])

  const value = useMemo<AuthValue>(
    () => ({ user, loading, isAdmin: computeIsAdmin(user), login, logout, reload }),
    [user, loading, login, logout, reload],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (ctx === null) throw new Error('useAuth necesita estar dentro de <AuthProvider>')
  return ctx
}

export default AuthProvider
