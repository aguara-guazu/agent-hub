import { useCallback, useEffect, useState } from "react"
import { Outlet } from "react-router-dom"
import { useDesktopNavigation } from "../lib/desktop"
import { useTheme } from "../lib/theme"
import { GlobalSearch } from "./GlobalSearch"
import { Sidebar } from "./Sidebar"
import { hasBlockingLayer } from "./ui/layers"
import { useShellStatus } from "./useShellStatus"

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

/** Shell de la app: barra lateral + contenido. Sin barra superior; las migas viven dentro de cada ficha. */
export function Layout() {
  const [searchOpen, setSearchOpen] = useState(false)
  const closeSearch = useCallback(() => setSearchOpen(false), [])
  const theme = useTheme()
  const status = useShellStatus()
  useDesktopNavigation()
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return
      event.preventDefault()
      if (searchOpen) { setSearchOpen(false); return }
      if (hasBlockingLayer() || document.querySelector("dialog[open]")) return
      setSearchOpen(true)
    }
    document.addEventListener("keydown", listener)
    return () => document.removeEventListener("keydown", listener)
  }, [searchOpen])
  return (
    <div className={`ah shell ${theme.className}`}>
      <Sidebar status={status} onSearch={() => setSearchOpen(true)} shortcut={IS_MAC ? "⌘K" : "Ctrl K"} />
      <main className="main">
        <Outlet />
      </main>
      <GlobalSearch open={searchOpen} onClose={closeSearch} status={status} theme={theme} />
    </div>
  )
}

export default Layout
