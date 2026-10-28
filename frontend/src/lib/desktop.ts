import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

/** Rutas que el proceso principal puede pedir; la misma lista blanca valida en `desktop/src/navigation.ts`. */
const DESKTOP_ROUTES: readonly RegExp[] = [/^\/brief\/[A-Za-z0-9_-]{1,80}$/, /^\/schedules$/, /^\/settings$/]

export function isDesktopRoute(route: string): boolean {
  return DESKTOP_ROUTES.some(pattern => pattern.test(route))
}

/** Sigue los pedidos de navegación del escritorio (clic en una notificación); sin la app de escritorio no hace nada. */
export function useDesktopNavigation(): void {
  const navigate = useNavigate()
  useEffect(() => window.agentHub?.onNavigate?.(route => { if (isDesktopRoute(route)) navigate(route) }), [navigate])
}
