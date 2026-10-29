import { describe, expect, it } from 'vitest'
import { markdownToEmailHtml, renderSelfEmail } from './email-html.js'

describe('HTML de los correos', () => {
  it('interpreta títulos, énfasis, listas anidadas, citas, código y tablas con estilos en línea', () => {
    const html = markdownToEmailHtml(['## Agenda', '', 'Texto con **negrita**, *énfasis* y `código`.', '', '- uno', '  - dos', '1. tres', '', '> cita', '', '```', 'a < b', '```', '', '| A | B |', '|---|---|', '| 1 | 2 |'].join('\n'))
    expect(html).toContain('<h3 style=')
    expect(html).toContain('<strong>negrita</strong>')
    expect(html).toContain('<em>énfasis</em>')
    expect(html).toMatch(/<code style="[^"]+">código<\/code>/)
    expect(html).toMatch(/<ul style="[^"]+"><li style="[^"]+">uno<ul/)
    expect(html).toMatch(/<ol style="[^"]+"><li style="[^"]+">tres<\/li><\/ol>/)
    expect(html).toContain('<blockquote')
    expect(html).toContain('a &lt; b</pre>')
    expect(html).toMatch(/<th style="[^"]+">A<\/th>/)
    expect(html).toMatch(/<td style="[^"]+">2<\/td>/)
  })

  it('escapa el HTML del origen y solo enlaza http, https y mailto, sin cargar imágenes', () => {
    const html = markdownToEmailHtml('<script>alert(1)</script> [ok](https://example.com/a?b=1&c=2) [mal](javascript:alert(1)) ![logo](https://example.com/x.png) "comillas"')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('href="https://example.com/a?b=1&amp;c=2"')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<img')
    expect(html).toContain('Imagen: logo')
    expect(html).toContain('&quot;comillas&quot;')
  })

  it('el documento lleva título escapado, vista previa oculta, el bloque de decisión y el pie', () => {
    const html = renderSelfEmail({ title: 'Cierre <17:30>', markdown: 'Resumen del día', decision: { items: [{ ordinal: 2, summary: 'Registrar 0.5 h & más' }], reply_line: 'aprobar ABC 2', expires: '2026-10-30T20:00:00Z' } })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>Cierre &lt;17:30&gt;</title>')
    expect(html).toMatch(/<div style="display:none[^"]*">Resumen del día<\/div>/)
    expect(html).toContain('value="2">Registrar 0.5 h &amp; más</li>')
    expect(html).toContain('aprobar ABC 2')
    expect(html).toContain('Agent Hub envió este correo a tu propia cuenta')
    expect(renderSelfEmail({ title: 't', markdown: 'x' })).not.toContain('Para decidir')
  })

  it('recorta un contenido enorme y lo avisa', () => {
    expect(markdownToEmailHtml('a'.repeat(200_001))).toContain('se muestra recortado')
  })
})
