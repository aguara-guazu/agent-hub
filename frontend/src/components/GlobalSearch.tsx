import { useEffect, useId, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import { api } from "../lib/api"
import type { useTheme } from "../lib/theme"
import { Icon, type IconName } from "./Icon"
import { Avatar, Kbd, Tag } from "./ui/basics"
import { Layer, trapTab, useLayer } from "./ui/layers"
import { relativeTime } from "./ui/time"
import { useT } from "../i18n/useT"
import { DESTINATIONS, type useShellStatus } from "./useShellStatus"

interface SearchRow { key: string; entity_id: string; title: string; kind: string; href: string; updated_at: string }
interface SearchResults { items: SearchRow[] }

type Group = "memory" | "goto" | "actions"

interface PaletteItem {
  id: string
  group: Group
  label: string
  lead: ReactNode
  meta?: ReactNode
  run: () => void
}

const ENTITY_KINDS = ["company", "project", "person", "meeting", "event", "document", "message", "issue", "note", "collection", "fact"] as const
type EntityKind = (typeof ENTITY_KINDS)[number]

function entityKind(kind: string): EntityKind | "other" {
  return (ENTITY_KINDS as readonly string[]).includes(kind) ? kind as EntityKind : "other"
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
}

function matches(query: string, ...texts: string[]): boolean {
  if (!query) return true
  const needle = normalize(query)
  return texts.some(text => normalize(text).includes(needle))
}

/** Resalta la primera coincidencia sin acentos de por medio. */
function highlight(text: string, query: string): ReactNode {
  if (!query) return text
  const index = normalize(text).indexOf(normalize(query))
  if (index < 0) return text
  return <>{text.slice(0, index)}<b>{text.slice(index, index + query.length)}</b>{text.slice(index + query.length)}</>
}

const GROUP_KEYS = { memory: "cmdk.groupMemory", goto: "cmdk.groupGoto", actions: "cmdk.groupActions" } as const satisfies Record<Group, string>

export interface GlobalSearchProps {
  open: boolean
  onClose: () => void
  status: ReturnType<typeof useShellStatus>
  theme: ReturnType<typeof useTheme>
}

/** «Buscar o ir a…» (⌘K): memoria, destinos y acciones. ↑↓ moverse, ↵ abrir, esc cerrar. */
export function GlobalSearch({ open, onClose, status, theme }: GlobalSearchProps) {
  if (!open) return null
  return <Palette onClose={onClose} status={status} theme={theme} />
}

function Palette({ onClose, status, theme }: Omit<GlobalSearchProps, "open">) {
  const navigate = useNavigate()
  const { t } = useT("nav")
  const { t: ts } = useT("status")
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [active, setActive] = useState(0)
  const trimmed = query.trim()
  useLayer(true, "palette", onClose)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(trimmed), 200)
    return () => clearTimeout(timer)
  }, [trimmed])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    input.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])

  const search = useQuery({
    queryKey: ["memory", "palette-search", debounced],
    queryFn: ({ signal }) => api.post<SearchResults>("/memory/search", { query: debounced, limit: 6, offset: 0 }, signal),
    retry: false,
    staleTime: 15_000,
  })
  const waiting = trimmed !== debounced || search.isPending

  const items = useMemo<PaletteItem[]>(() => {
    const go = (to: string) => () => { onClose(); navigate(to) }
    const memory: PaletteItem[] = waiting || search.isError ? [] : [...new Map((search.data?.items ?? []).map(row => [row.entity_id, row])).values()].slice(0, 6).map(row => ({
      id: `m-${row.entity_id}`,
      group: "memory",
      label: row.title,
      lead: row.kind === "project" || row.kind === "company" || row.kind === "person"
        ? <Avatar name={row.title} small round={row.kind === "person"} />
        : <Tag>{ts(`entity.${entityKind(row.kind)}`)}</Tag>,
      meta: <span className="xs t3">{row.kind === "project" || row.kind === "company" || row.kind === "person" ? ts(`entity.${entityKind(row.kind)}`) : relativeTime(row.updated_at)}</span>,
      run: go(row.href),
    }))
    const destinations: PaletteItem[] = DESTINATIONS
      .filter(destination => matches(trimmed, t(destination.labelKey), destination.keywordsKey ? t(destination.keywordsKey) : ""))
      .map(destination => ({ id: `g-${destination.to}`, group: "goto", label: t(destination.labelKey), lead: <Icon name={destination.icon} />, run: go(destination.to) }))
    const actionList: Array<{ id: string; key: "cmdk.newProject" | "cmdk.newNote" | "cmdk.addServer" | "cmdk.newSkill" | "cmdk.sync" | "cmdk.themeLight" | "cmdk.themeDark"; icon: IconName; run: () => void }> = [
      { id: "new-project", key: "cmdk.newProject", icon: "add", run: go("/projects?new=project") },
      { id: "new-note", key: "cmdk.newNote", icon: "note", run: go("/memory?new=note") },
      { id: "add-server", key: "cmdk.addServer", icon: "add", run: go("/servers?new=server") },
      { id: "new-skill", key: "cmdk.newSkill", icon: "add", run: go("/skills?new=skill") },
      { id: "sync", key: "cmdk.sync", icon: "sync", run: () => { onClose(); status.sync.mutate() } },
      { id: "theme", key: theme.theme === "dark" ? "cmdk.themeLight" : "cmdk.themeDark", icon: theme.theme === "dark" ? "sun" : "moon", run: () => { theme.toggle(); onClose() } },
    ]
    const actions: PaletteItem[] = actionList
      .filter(action => matches(trimmed, t(action.key)))
      .map(action => ({ id: `a-${action.id}`, group: "actions", label: t(action.key), lead: <Icon name={action.icon} />, run: action.run }))
    if (trimmed) {
      actions.push({
        id: "search-all",
        group: "actions",
        label: t("cmdk.searchAll", { query: trimmed }),
        lead: <Icon name="find" />,
        meta: <Kbd>↵</Kbd>,
        run: go(`/memory?q=${encodeURIComponent(trimmed)}`),
      })
    }
    return [...memory, ...destinations, ...actions]
  }, [waiting, search.isError, search.data, trimmed, onClose, navigate, status.sync, theme, t, ts])

  // Con texto y sin coincidencias propias, la opción activa por defecto es buscar en toda la memoria.
  useEffect(() => {
    setActive(items.findIndex(item => item.group === "memory" || item.group === "goto") >= 0 ? 0 : Math.max(0, items.length - 1))
  }, [debounced, items.length])

  function move(next: number) {
    if (items.length === 0) return
    const index = (next + items.length) % items.length
    setActive(index)
    document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: "nearest" })
  }

  let lastGroup: Group | null = null
  return (
    <Layer>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 55, background: "var(--overlay)", display: "flex", justifyContent: "center", alignItems: "flex-start", padding: "12vh var(--sp-5) var(--sp-5)" }}
        onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
      >
        <div
          ref={root}
          className="pop"
          role="dialog"
          aria-modal="true"
          aria-label={t("cmdk.title")}
          style={{ width: "100%", maxWidth: 560, display: "flex", flexDirection: "column", maxHeight: "76vh" }}
          onKeyDown={event => trapTab(event, root.current)}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", padding: "0 var(--sp-4)", height: "var(--row-h)", borderBottom: "1px solid var(--border)", flex: "none" }}>
            <Icon name="find" style={{ color: "var(--text-3)" }} />
            <input
              ref={input}
              className="input"
              value={query}
              maxLength={2000}
              placeholder={t("cmdk.placeholder")}
              aria-label={t("cmdk.placeholder")}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={items[active] ? `${listId}-${active}` : undefined}
              style={{ border: 0, background: "transparent", padding: 0, height: "calc(var(--row-h) - 2px)", fontSize: "var(--fs-lg)", boxShadow: "none" }}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.nativeEvent.isComposing) return
                if (event.key === "ArrowDown") { event.preventDefault(); move(active + 1) }
                else if (event.key === "ArrowUp") { event.preventDefault(); move(active - 1) }
                else if (event.key === "Enter") { event.preventDefault(); items[active]?.run() }
              }}
            />
            <Kbd>esc</Kbd>
          </div>
          <div id={listId} role="listbox" aria-label={t("cmdk.title")} style={{ padding: "var(--sp-1)", display: "flex", flexDirection: "column", overflowY: "auto", minHeight: 0 }}>
            {waiting && <span className="eyebrow" role="status" style={{ padding: "var(--sp-2) var(--sp-3) var(--sp-1)" }}>{t("cmdk.searching")}</span>}
            {search.isError && !waiting && <span className="xs t3" role="status" style={{ padding: "var(--sp-2) var(--sp-3)" }}>{t("cmdk.searchError")}</span>}
            {items.map((item, index) => {
              const heading = item.group !== lastGroup
              lastGroup = item.group
              return (
                <div key={item.id} style={{ display: "contents" }}>
                  {heading && <span className="eyebrow" aria-hidden="true" style={{ padding: "var(--sp-2) var(--sp-3) var(--sp-1)" }}>{t(GROUP_KEYS[item.group])}</span>}
                  <div
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    className="menu-item"
                    style={index === active ? { background: "var(--surface-2)" } : undefined}
                    onMouseMove={() => { if (index !== active) setActive(index) }}
                    onMouseDown={event => event.preventDefault()}
                    onClick={item.run}
                  >
                    {item.lead}
                    <span className="trunc" style={{ flex: 1 }} title={item.label}>{item.group === "actions" ? item.label : highlight(item.label, trimmed)}</span>
                    {item.meta}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="xs t3" style={{ display: "flex", gap: "var(--sp-4)", padding: "var(--sp-2) var(--sp-4)", borderTop: "1px solid var(--border)", flex: "none" }}>
            <span><Kbd>↑↓</Kbd> {t("cmdk.hintMove")}</span>
            <span><Kbd>↵</Kbd> {t("cmdk.hintOpen")}</span>
            <span><Kbd>esc</Kbd> {t("cmdk.hintClose")}</span>
          </div>
        </div>
      </div>
    </Layer>
  )
}

export default GlobalSearch
