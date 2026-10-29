/** Iconos en línea, sin librería. Trazo con `currentColor`; dentro de `.ico` el grosor y las puntas salen de ah.css.
 *  Los iconos del sistema nuevo usan una caja de 24 (los de la barra lateral son fijos); los previos, una de 16. */

import type { ReactNode, SVGProps } from "react"

const LEGACY_16 = {
  matrix: <><rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.75" /><path d="M2.25 6.5h11.5M2.25 10h11.5M6.5 2.25v11.5" /></>,
  catalog: <><path d="M8 1.75 14 5v6L8 14.25 2 11V5z" /><path d="m2 5 6 3.25L14 5M8 8.25v6" /></>,
  skills: <><path d="M8 4.2C6.9 3.2 5.4 2.75 3.6 2.75H2v9.5h1.6c1.8 0 3.3.45 4.4 1.45 1.1-1 2.6-1.45 4.4-1.45H14v-9.5h-1.6c-1.8 0-3.3.45-4.4 1.45z" /><path d="M8 4.2v9.5" /></>,
  machines: <><rect x="2.75" y="3.25" width="10.5" height="7" rx="1.25" /><path d="M1.25 12.75h13.5" /></>,
  users: <><circle cx="6.25" cy="5.5" r="2.25" /><path d="M1.75 13.25c0-2.2 2-3.75 4.5-3.75s4.5 1.55 4.5 3.75" /><path d="M11 3.6a2.25 2.25 0 0 1 0 4.3M12.4 9.9c1.2.5 1.95 1.5 1.95 2.85" /></>,
  audit: <><circle cx="8" cy="8" r="6.25" /><path d="M8 4.5V8l2.5 1.75" /></>,
  hub: <><circle cx="8" cy="8" r="2" /><circle cx="3" cy="3.5" r="1.4" /><circle cx="13" cy="3.5" r="1.4" /><circle cx="8" cy="14" r="1.4" /><path d="m4.2 4.6 2.4 2.2M11.8 4.6 9.4 6.8M8 10v2.6" /></>,
  back: <path d="M13 8H3m5-5L3 8l5 5" />,
  sparkles: <path d="m6 2 1.5 4.5L12 8l-4.5 1.5L6 14 4.5 9.5 0 8l4.5-1.5L6 2ZM12 1l.75 2.25L15 4l-2.25.75L12 7l-.75-2.25L9 4l2.25-.75L12 1Z" />,
  filter: <><path d="M2 4h12M2 12h12" /><circle cx="6" cy="4" r="2" fill="var(--surface)" /><circle cx="10" cy="12" r="2" fill="var(--surface)" /></>,
  document: <><path d="M9 1.5H3v13h10v-9L9 1.5Z" /><path d="M9 1.5v4h4M5.5 8h5M5.5 11h4" /></>,
} satisfies Record<string, ReactNode>

const SYSTEM_24 = {
  brand: <><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="12" cy="18" r="2.5" /><path d="M7.5 8 11 15.5M16.5 8 13 15.5" /></>,
  home: <><path d="M4 13h4l2 3h4l2-3h4" /><path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" /></>,
  projects: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  memory: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  collaboration: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  automations: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  servers: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />,
  book: <path d="M4 5h5a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H4zM20 5h-5a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h6z" />,
  clients: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  sync: <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  find: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  add: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  done: <path d="m5 12 5 5L20 7" />,
  warning: <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />,
  error: <><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></>,
  down: <path d="m6 9 6 6 6-6" />,
  right: <path d="m9 6 6 6-6 6" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  note: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  person: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" /></>,
} satisfies Record<string, ReactNode>

const ALIASES = {
  search: "find",
  plus: "add",
  alert: "warning",
  x: "close",
  check: "done",
  chevron: "down",
  refresh: "sync",
} as const

export type IconName = keyof typeof LEGACY_16 | keyof typeof SYSTEM_24 | keyof typeof ALIASES

function resolve(name: IconName): { box: 16 | 24; paths: ReactNode } {
  const target = (ALIASES as Record<string, string>)[name] ?? name
  if (target in SYSTEM_24) return { box: 24, paths: SYSTEM_24[target as keyof typeof SYSTEM_24] }
  return { box: 16, paths: LEGACY_16[target as keyof typeof LEGACY_16] }
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName
  /** Solo cuando el icono comunica algo que no está escrito al lado. */
  title?: string
  /** 14 px en lugar de 16 px. */
  small?: boolean
}

export function Icon({ name, title, small = false, className, ...rest }: IconProps) {
  const { box, paths } = resolve(name)
  return (
    <svg
      viewBox={`0 0 ${box} ${box}`}
      className={["ico", small ? "ico-sm" : "", className ?? ""].filter(Boolean).join(" ")}
      fill="none"
      stroke="currentColor"
      strokeWidth={box === 24 ? 1.75 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
      {...rest}
    >
      {title && <title>{title}</title>}
      {paths}
    </svg>
  )
}

export default Icon
