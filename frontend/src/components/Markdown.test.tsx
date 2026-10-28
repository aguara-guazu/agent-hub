import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Markdown, MARKDOWN_MAX_CHARS, safeHref } from './Markdown'
import { qa, renderWithProviders, setupDom, teardownDom } from '../test-utils'

beforeEach(setupDom)
afterEach(teardownDom)

async function render(source: string): Promise<HTMLElement> {
  const { container } = await renderWithProviders(<Markdown source={source} />)
  return container
}

describe('safeHref', () => {
  it('acepta http, https y mailto', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeHref('http://example.com')).toBe('http://example.com/')
    expect(safeHref('mailto:ana@example.com')).toBe('mailto:ana@example.com')
  })

  it('rechaza otros protocolos, rutas relativas y credenciales embebidas', () => {
    for (const raw of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'vbscript:x', '/relativa', '#ancla', '//example.com', 'https://user:pass@example.com', 'https://user@example.com', '']) {
      expect(safeHref(raw)).toBeNull()
    }
  })
})

describe('Markdown', () => {
  it('muestra el HTML crudo como texto y no crea elementos', async () => {
    const container = await render('<script>window.hack = 1</script>\n\n<img src="https://evil.example/x.png" onerror="alert(1)">\n\n<b>negrita</b>')
    expect(qa(container, 'script, img, b')).toHaveLength(0)
    expect(container.textContent).toContain('<script>window.hack = 1</script>')
    expect(container.textContent).toContain('<img src="https://evil.example/x.png" onerror="alert(1)">')
  })

  it('crea enlaces sólo con destinos permitidos y sin referer ni opener', async () => {
    const container = await render('[ok](https://example.com/x) [mal](javascript:alert(1)) [datos](data:text/html,x) [rel](/catalog)')
    const anchors = qa<HTMLAnchorElement>(container, 'a')
    expect(anchors.map(a => a.getAttribute('href'))).toEqual(['https://example.com/x'])
    expect(anchors[0]!.getAttribute('target')).toBe('_blank')
    expect(anchors[0]!.getAttribute('rel')).toBe('noopener noreferrer nofollow')
    expect(container.textContent).toContain('mal')
    expect(container.textContent).not.toContain('javascript:')
  })

  it('no carga imágenes remotas: muestra un enlace con la descripción', async () => {
    const container = await render('![gráfico](https://example.com/g.png) ![peligro](javascript:alert(1))')
    expect(qa(container, 'img')).toHaveLength(0)
    expect(qa<HTMLAnchorElement>(container, 'a').map(a => a.getAttribute('href'))).toEqual(['https://example.com/g.png'])
    expect(container.textContent).toContain('Imagen: gráfico')
    expect(container.textContent).toContain('Imagen: peligro')
  })

  it('interpreta títulos, énfasis, código y escapes', async () => {
    const container = await render('# Título\n\n## Sub\n\nTexto **fuerte**, _suave_, `a < b` y \\*literal\\*.')
    expect(qa(container, 'h2').map(h => h.textContent)).toEqual(['Título'])
    expect(qa(container, 'h3').map(h => h.textContent)).toEqual(['Sub'])
    expect(qa(container, 'strong')[0]!.textContent).toBe('fuerte')
    expect(qa(container, 'em')[0]!.textContent).toBe('suave')
    expect(qa(container, 'code')[0]!.textContent).toBe('a < b')
    expect(container.textContent).toContain('*literal*.')
  })

  it('interpreta listas anidadas, citas, bloques de código y tablas', async () => {
    const container = await render([
      '- uno', '  - uno.a', '- dos', '', '1. primero', '2. segundo', '', '> cita **fuerte**', '',
      '```', '<b>no es html</b>', '```', '', '| Tarea | Horas |', '| --- | ---: |', '| ABC-1 | 2 |', '| ABC-2 | 3 |',
    ].join('\n'))
    expect(qa(container, 'ul > li')).toHaveLength(3)
    expect(qa(container, 'ul ul > li')[0]!.textContent).toBe('uno.a')
    expect(qa(container, 'ol > li').map(li => li.textContent)).toEqual(['primero', 'segundo'])
    expect(qa(container, 'blockquote strong')[0]!.textContent).toBe('fuerte')
    expect(qa(container, 'pre code')[0]!.textContent).toBe('<b>no es html</b>')
    expect(qa(container, 'th').map(th => th.textContent)).toEqual(['Tarea', 'Horas'])
    expect(qa(container, 'tbody tr')).toHaveLength(2)
    expect(qa(container, 'b')).toHaveLength(0)
  })

  it('recorta el contenido que supera el tope y lo avisa', async () => {
    const container = await render(`${'a'.repeat(MARKDOWN_MAX_CHARS + 10)}`)
    expect(container.textContent).toContain('recortado')
    expect(container.textContent!.length).toBeLessThan(MARKDOWN_MAX_CHARS + 200)
  })

  it('no aplica énfasis ni enlaces a un párrafo gigante (costo acotado)', async () => {
    const started = Date.now()
    const container = await render(`${'**a '.repeat(3_000)}`)
    expect(qa(container, 'strong')).toHaveLength(0)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
