import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Runs inside the isolated memory demo, against the real HTTP API and PostgreSQL. */
export async function smokeGlobalSearch({ page, base, token, directory }) {
  const headers = { Authorization: `Bearer ${token}` }, created = []
  async function call(operation, input) {
    const response = await page.request.post(`${base}/api/memory/call`, { headers, data: { operation, input } })
    assert.equal(response.status(), 200, await response.text()); return response.json()
  }
  const originalAI = (await (await page.request.get(`${base}/api/memory/status`, { headers })).json()).ai
  const liveOllama = process.env.AGENTHUB_SEARCH_OLLAMA_SMOKE === '1'
  async function search(query) {
    const response = await page.request.post(`${base}/api/memory/search`, { headers, data: { query } })
    assert.equal(response.status(), 200, await response.text()); return response.json()
  }
  try {
    const project = await call('create_entity', { kind: 'project', title: 'Aster · búsqueda de prueba', data: { description: 'Infraestructura y continuidad del servicio' } }); created.push(project.id)
    const fact = await call('create_entity', { kind: 'fact', title: 'Continuidad entre regiones', data: { text: 'Los servicios funcionan en dos regiones. Si una región deja de responder, el tráfico pasa a la otra para mantener el sistema disponible.', category: 'decision', review_state: 'accepted' }, project_ids: [project.id] }); created.push(fact.id)
    const note = await call('create_entity', { kind: 'note', title: 'Validación de resiliencia', data: { text: 'Hacer un simulacro de caída regional y verificar que el cambio de tráfico sea automático.' }, project_ids: [project.id] }); created.push(note.id)
    if (liveOllama) {
      const saved = await page.request.put(`${base}/api/memory/ai`, { headers, data: { ...originalAI, embeddings_enabled: true, extraction: 'disabled' } })
      assert.equal(saved.status(), 200, await saved.text())
      const query = '¿Cómo mantenemos la disponibilidad ante una falla regional?'
      let result
      for (let attempt = 0; attempt < 45; attempt++) {
        result = await search(query)
        if (result.semantic_status === 'ready') break
        await delay(1000)
      }
      assert.equal(result.semantic_status, 'ready', JSON.stringify(result.coverage))
      assert.ok(result.items.slice(0, 3).some(item => item.entity_id === fact.id), 'El conocimiento semántico debe aparecer entre los primeros resultados sin coincidencia textual')
    }
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(`${base}/#/projects`)
    await page.getByLabel('Buscar proyectos', { exact: true }).fill('Aster')
    await page.getByRole('link', { name: /Aster · búsqueda de prueba/ }).click()
    await page.getByRole('button', { name: 'Decisiones y hallazgos', exact: true }).click()
    await page.locator('.memory-entity-row').filter({ hasText: fact.title }).click()
    await page.getByRole('heading', { name: fact.title, exact: true }).waitFor()
    await page.getByRole('button', { name: 'Volver atrás', exact: true }).click()
    await page.locator('.memory-project-tabs .active').getByText('Decisiones y hallazgos').waitFor()
    await page.getByRole('button', { name: 'Volver atrás', exact: true }).click()
    assert.equal(await page.getByLabel('Buscar proyectos', { exact: true }).inputValue(), 'Aster')
    const trigger = page.getByRole('button', { name: 'Buscar en toda tu memoria', exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Buscar en toda tu memoria' })
    const input = dialog.getByRole('combobox', { name: 'Buscar en toda tu memoria' })
    await input.waitFor()
    await page.waitForFunction(() => globalThis.document.querySelector('dialog [role="option"]'))
    await page.screenshot({ animations: 'disabled', path: join(directory, 'screenshots', '07-global-search-start.png') })
    // Native modal keeps keyboard focus inside and returns it to its trigger.
    await page.keyboard.press('Shift+Tab')
    assert.ok(await page.evaluate(() => globalThis.document.querySelector('dialog').contains(globalThis.document.activeElement)))
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    assert.ok(await trigger.evaluate(node => node === globalThis.document.activeElement))
    await page.keyboard.press('Control+k')
    await input.fill(liveOllama ? '¿Cómo mantenemos la disponibilidad ante una falla regional?' : 'continuidad')
    await dialog.getByRole('option').filter({ hasText: fact.title }).waitFor()
    await page.screenshot({ animations: 'disabled', path: join(directory, 'screenshots', '08-global-search-results.png') })
    await dialog.getByRole('button', { name: /^Filtros/ }).click()
    await dialog.getByLabel('Proyecto', { exact: true }).selectOption(project.id)
    await dialog.getByRole('button', { name: 'Conocimientos', exact: true }).click()
    await page.waitForFunction(() => globalThis.document.querySelectorAll('dialog [role="option"]').length === 1)
    await page.screenshot({ animations: 'disabled', path: join(directory, 'screenshots', '09-global-search-filters.png') })
    await page.setViewportSize({ width: 768, height: 1024 })
    assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth))
    await page.screenshot({ animations: 'disabled', path: join(directory, 'screenshots', '10-global-search-compact.png') })
    await input.focus(); await page.keyboard.press('Enter')
    await page.getByRole('heading', { name: fact.title, exact: true }).waitFor()
    assert.ok(page.url().includes(fact.id))
    console.log(`Búsqueda global verificada: atrás con contexto, filtros, teclado, foco, vista compacta y ${liveOllama ? 'vectores reales de Ollama' : 'búsqueda textual'}.`)
  } finally {
    if (liveOllama) await page.request.put(`${base}/api/memory/ai`, { headers, data: originalAI })
    for (const id of created.reverse()) await call('delete_entity', { id })
  }
}
