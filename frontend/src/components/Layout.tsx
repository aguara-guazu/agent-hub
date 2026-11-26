import { Loading, ErrorState } from "./ui/display"
import { Suspense, useCallback, useEffect, useState } from "react"
import { dependencies, destinationModule } from '@agenthub/shared/modules'
import { useModules } from '../modules/state'
import { Navigate, Outlet, useLocation } from "react-router-dom"
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
  const owner = destinationModule(useLocation().pathname)
  const modules = useModules()
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
        {owner && modules.isPending ? <Loading />
          : owner && modules.isError && !modules.data ? <ErrorState error={modules.error} onRetry={() => void modules.refetch()} />
          : owner && (modules.data?.[owner] === false || dependencies(owner).some(id=>modules.data?.[id]===false))
          ? <Navigate replace to={'/settings?section=' + owner} />
          : <Suspense fallback={<Loading />}><Outlet /></Suspense>}
      </main>
      <GlobalSearch open={searchOpen} onClose={closeSearch} status={status} theme={theme} />
    </div>
  )
}

export default Layout
