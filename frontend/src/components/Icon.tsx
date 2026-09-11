/** Iconos en línea.
 *
 *  Sin librería a propósito: son doce trazos y una dependencia de iconos pesa
 *  más que todo esto junto. Trazo de 1.5 sobre una caja de 16, `currentColor`
 *  siempre, para que hereden el color del contexto sin reglas extra.
 */

import type { ReactNode, SVGProps } from 'react'

export type IconName =
  | 'matrix'
  | 'catalog'
  | 'skills'
  | 'machines'
  | 'users'
  | 'audit'
  | 'hub'
  | 'chevron'
  | 'search'
  | 'plus'
  | 'alert'
  | 'info'
  | 'check'
  | 'x'
  | 'refresh'

const PATHS: Record<IconName, ReactNode> = {
  // Cuadrícula: la matriz de recursos por agentes.
  matrix: (
    <>
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.75" />
      <path d="M2.25 6.5h11.5M2.25 10h11.5M6.5 2.25v11.5" />
    </>
  ),
  // Caja: el catálogo de MCP servers publicados.
  catalog: (
    <>
      <path d="M8 1.75 14 5v6L8 14.25 2 11V5z" />
      <path d="m2 5 6 3.25L14 5M8 8.25v6" />
    </>
  ),
  // Libro abierto: las skills.
  skills: (
    <>
      <path d="M8 4.2C6.9 3.2 5.4 2.75 3.6 2.75H2v9.5h1.6c1.8 0 3.3.45 4.4 1.45 1.1-1 2.6-1.45 4.4-1.45H14v-9.5h-1.6c-1.8 0-3.3.45-4.4 1.45z" />
      <path d="M8 4.2v9.5" />
    </>
  ),
  // Portátil: las máquinas con daemon.
  machines: (
    <>
      <rect x="2.75" y="3.25" width="10.5" height="7" rx="1.25" />
      <path d="M1.25 12.75h13.5" />
    </>
  ),
  users: (
    <>
      <circle cx="6.25" cy="5.5" r="2.25" />
      <path d="M1.75 13.25c0-2.2 2-3.75 4.5-3.75s4.5 1.55 4.5 3.75" />
      <path d="M11 3.6a2.25 2.25 0 0 1 0 4.3M12.4 9.9c1.2.5 1.95 1.5 1.95 2.85" />
    </>
  ),
  // Reloj con historial: el ledger.
  audit: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.5V8l2.5 1.75" />
    </>
  ),
  // Marca: tres nodos convergiendo en uno. El hub.
  hub: (
    <>
      <circle cx="8" cy="8" r="2" />
      <circle cx="3" cy="3.5" r="1.4" />
      <circle cx="13" cy="3.5" r="1.4" />
      <circle cx="8" cy="14" r="1.4" />
      <path d="m4.2 4.6 2.4 2.2M11.8 4.6 9.4 6.8M8 10v2.6" />
    </>
  ),
  chevron: <path d="m4 6 4 4 4-4" />,
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.45" />
      <path d="m10.6 10.6 3 3" />
    </>
  ),
  plus: <path d="M8 3.25v9.5M3.25 8h9.5" />,
  alert: (
    <>
      <path d="M8 2.4 14.5 13.6h-13z" />
      <path d="M8 6.5v3.2M8 11.7v.05" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.3v3.9M8 5.1v.05" />
    </>
  ),
  check: <path d="m3.5 8.4 3 3 6-6.8" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  refresh: (
    <>
      <path d="M13.2 7a5.25 5.25 0 1 0-.35 3.4" />
      <path d="M13.6 3.2V7h-3.8" />
    </>
  ),
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  /** Sólo cuando el icono comunica algo que no está escrito al lado. */
  title?: string
}

export function Icon({ name, title, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  )
}

export default Icon
