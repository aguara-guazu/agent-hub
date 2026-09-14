import { describe, expect, it } from 'vitest'
import { memoryTools } from '../src/operations.js'
import { memorySkill, renderMemorySkill } from '../src/skill.js'

describe('skill de fábrica de la memoria', () => {
  it('documenta todas las herramientas con su nombre expuesto y sin frontmatter propio', () => {
    const body = memorySkill.body
    for (const tool of memoryTools) expect(body).toContain(`\`memory_${tool.name}\`: ${tool.description}`)
    expect(body.startsWith('# ')).toBe(true)
    expect(body).toContain('hub')
    // Navigation comes first: data model, how to read responses and step-by-step recipes precede writing.
    const order = ['## Cómo está organizada', '## Cómo leer cada respuesta', '## Recetas de navegación', '## Cómo responder', '## Guardar y corregir', '## Referencia de herramientas'].map(h => body.indexOf(h))
    expect(order.every((index, i) => index > 0 && (i === 0 || index > order[i - 1]!))).toBe(true)
    for (const link of ['participant', 'calendar_event', 'meeting_document', 'derived_from']) expect(body).toContain(`\`${link}\``)
    expect(body).toContain('exhaustive')
    expect(memorySkill.slug).toMatch(/^[a-z0-9][a-z0-9._-]*$/)
    expect(memorySkill.description.length).toBeLessThan(400)
  })
  it('agrupa una herramienta nueva aunque no tenga sección asignada', () => {
    const body = renderMemorySkill([...memoryTools, { name: 'nueva_operacion', description: 'Algo nuevo.' }])
    expect(body).toContain('### Otras')
    expect(body).toContain('`memory_nueva_operacion`: Algo nuevo.')
  })
})
