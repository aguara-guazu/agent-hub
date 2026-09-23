import { useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { Icon } from './Icon'

export function NavigationControls() {
  const location = useLocation(), navigate = useNavigate(), action = useNavigationType()
  const history = useRef({ keys: [location.key], position: 0 }), [, redraw] = useState(0)
  useLayoutEffect(() => {
    const value = history.current
    if (value.keys[value.position] === location.key) return
    if (action === 'PUSH') { value.keys = [...value.keys.slice(0,value.position+1),location.key]; value.position++ }
    else if (action === 'REPLACE') value.keys[value.position] = location.key
    else {
      const position = value.keys.indexOf(location.key)
      if (position >= 0) value.position = position
      else { value.keys = [location.key]; value.position = 0 }
    }
    redraw(v => v + 1)
  }, [location.key, action])
  // HashRouter's index also survives a reload; never use history.length, which includes other websites.
  const hasHistory = history.current.position > 0 || (window.history.state?.idx ?? 0) > 0
  const parent = location.pathname.startsWith('/projects/') ? '/projects' : location.pathname.startsWith('/memory/') ? '/memory' : null
  const labels: Record<string,string> = { catalog: 'MCP servers', skills: 'Skills', projects: 'Proyectos', memory: 'Memoria', clients: 'Clientes', activity: 'Actividad', settings: 'Ajustes' }
  return <div className="hub-navigation-controls">
    <button className="hub-back-button" aria-label="Volver atrás" title="Volver atrás" disabled={!hasHistory && !parent}
      onClick={() => hasHistory ? navigate(-1) : parent && navigate(parent, { replace: true })}><Icon name="back" /></button>
    <span className="hub-navigation-separator" /><span className="hub-current-section">{labels[location.pathname.split('/')[1]!] ?? 'Agent Hub'}</span>
  </div>
}
