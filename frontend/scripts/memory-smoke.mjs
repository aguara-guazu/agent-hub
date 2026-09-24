import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { smokeGlobalSearch } from './search-smoke.mjs'

/** Real browser + real API/database. Uses only fictitious demo data and removes its new entities. */
export async function smokeMemoryUI({ base, token, directory }) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'dark' })
  const errors = [], created = []
  const shots = join(directory, 'screenshots')
  await mkdir(shots, { recursive: true })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  async function call(operation, input = {}) {
    const response = await page.request.post(`${base}/api/memory/call`, { headers: { Authorization: `Bearer ${token}` }, data: { operation, input } })
    assert.equal(response.status(), 200, await response.text())
    return response.json()
  }
  const go = async path => { await page.goto(`${base}/#${path}`); await page.waitForLoadState('networkidle') }
  const shot = name => page.screenshot({ path: join(shots, `${name}.png`), fullPage: true })
  try {
    await page.addInitScript(value => { globalThis.localStorage.setItem('agenthub.token', value) }, token)
    await go('/projects')
    await page.getByRole('heading', { name: 'Proyectos', exact: true }).waitFor()
    await page.getByRole('link', { name: /POC de soporte · ejemplo/ }).click()
    await page.getByRole('heading', { name: 'POC de soporte · ejemplo', exact: true }).waitFor()
    await shot('01-project')
    await page.getByRole('link', { name: /Seguimiento interno/ }).first().click()
    await page.getByRole('heading', { name: 'Transcripción', exact: true }).waitFor()
    await page.locator('.memory-utterance').nth(3).waitFor()
    assert.equal(await page.locator('.memory-utterance').count(), 4)
    await page.getByRole('button', { name: 'Citar fragmento', exact: true }).nth(1).click()
    await page.locator('.memory-utterance.highlighted').waitFor()
    assert.match(page.url(), /version=.*fragment=/)
    await shot('02-transcript')
    await page.getByRole('link', { name: 'Martín Díaz', exact: true }).first().click()
    await page.getByRole('heading', { name: 'Martín Díaz', exact: true }).waitFor()
    await page.getByRole('link', { name: 'Ver intervenciones', exact: true }).click()
    await page.locator('.memory-evidence').first().waitFor()
    assert.equal(await page.locator('.memory-evidence').count(), 2)
    await shot('03-search')

    await go('/projects')
    await page.getByRole('button', { name: 'Nuevo proyecto', exact: true }).click()
    await page.getByLabel('Nombre', { exact: true }).fill('Proyecto de prueba UI')
    await page.getByLabel('Descripción', { exact: true }).fill('Creado por la prueba de navegador; se elimina al terminar.')
    await page.getByRole('button', { name: 'Crear', exact: true }).click()
    await page.getByRole('heading', { name: 'Proyecto de prueba UI', exact: true }).waitFor()
    const projectId = page.url().split('/projects/')[1]
    created.push(projectId)
    await page.getByRole('button', { name: 'Tareas', exact: true }).click()
    await page.getByLabel('Clave del proyecto en Jira').fill('UITEST')
    await page.getByRole('button', { name: 'Guardar', exact: true }).click()
    await page.getByText('Proyecto UITEST', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Nuevo pendiente', exact: true }).click()
    await page.getByLabel('Título', { exact: true }).fill('Revisar implementación')
    await page.getByRole('dialog').getByRole('button', { name: 'Guardar', exact: true }).click()
    await page.getByRole('button', { name: /Revisar implementación/ }).click()
    await page.getByRole('button', { name: 'Marcar en curso', exact: true }).click()
    await page.getByRole('dialog').getByText('En curso', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('tab', { name: 'Notas de agentes', exact: true }).click()
    await page.getByLabel('Dejar una nota para los agentes', { exact: true }).fill('La revisión de UI está en curso.')
    await page.getByRole('button', { name: 'Guardar nota', exact: true }).click()
    await page.locator('.memory-notes').getByText('La revisión de UI está en curso.', { exact: true }).waitFor()
    await shot('tasks-notes')
    await page.getByRole('tab', { name: 'Estadísticas', exact: true }).click()
    const downloadEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Exportar HTML', exact: true }).click()
    const download = await downloadEvent
    assert.match(download.suggestedFilename(), /-tareas-.*\.html$/)
    assert.equal(await download.failure(), null)
    await shot('tasks-stats')
    await page.getByRole('button', { name: 'Línea de tiempo', exact: true }).click()
    await page.getByRole('button', { name: 'Importar fuente', exact: true }).click()
    await page.getByLabel('Archivo para importar', { exact: true }).setInputFiles({ name: 'prueba-ui.vtt', mimeType: 'text/vtt', buffer: Buffer.from('WEBVTT\n\n00:00:02.000 --> 00:00:05.000\n<v Ana>La revisión será el jueves a las 15.\n\n00:00:06.000 --> 00:00:09.000\n<v Martín>Confirmo mi asistencia.\n') })
    await page.getByRole('button', { name: 'Importar fuente', exact: true }).last().click()
    await page.getByRole('heading', { name: 'prueba-ui', exact: true }).waitFor()
    const importedId = page.url().split('/entities/')[1]
    created.push(importedId)
    await page.getByText('La revisión será el jueves a las 15.', { exact: true }).waitFor()
    const transcript = await call('transcript', { entity_id: importedId })
    assert.equal(transcript.total, 2)
    assert.deepEqual(transcript.items[0].project_ids, [projectId])
    for (const fragment of transcript.items) if (fragment.speaker_id) created.push(fragment.speaker_id)

    await go('/memory')
    await page.getByRole('button', { name: 'Nueva colección', exact: true }).click()
    await page.getByLabel('Nombre', { exact: true }).fill('Horarios de prueba UI')
    await page.getByRole('button', { name: 'Crear', exact: true }).click()
    await page.getByRole('heading', { name: 'Horarios de prueba UI', exact: true }).waitFor()
    const collectionId = page.url().split('/entities/')[1]
    created.push(collectionId)
    await page.getByRole('button', { name: 'Nueva fila', exact: true }).click()
    await page.getByLabel('Detalle *', { exact: true }).fill('Jueves a las 15')
    await page.getByLabel('IDs de evidencia (opcional, uno por línea)').fill(transcript.items[0].id)
    await page.getByRole('button', { name: 'Guardar fila', exact: true }).click()
    await page.getByRole('cell', { name: 'Jueves a las 15', exact: true }).waitFor()
    await page.getByLabel('Filtrar columna').selectOption('detalle')
    await page.getByLabel('Valor exacto del filtro').fill('Jueves a las 15')
    await page.getByRole('link', { name: 'Fuente 1 ↗', exact: true }).waitFor()
    await shot('04-collection')
    assert.equal((await call('list_records', { collection_id: collectionId })).total, 1)

    await go('/memory/sources')
    await page.getByRole('heading', { name: 'Fuentes y ajustes', exact: true }).waitFor()
    await page.getByText('Procesamiento en segundo plano: activo', { exact: true }).waitFor({ timeout: 30_000 })
    await shot('05-settings')
    await page.setViewportSize({ width: 768, height: 1024 })
    await go('/projects')
    assert.ok(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.window.innerWidth), 'La UI desborda el ancho disponible')
    await shot('06-compact')
    await smokeGlobalSearch({ page, base, token, directory })
    assert.deepEqual(errors, [])
    console.log('UI verificada: proyecto, importación VTT, citas, persona, búsqueda, colección, ajustes, worker y vista compacta. Sin errores de navegador.')
    console.log(`Capturas: ${shots}`)
  } catch (error) {
    await shot('failure').catch(() => undefined)
    throw error
  } finally {
    for (const id of [...new Set(created)].reverse()) await call('delete_entity', { id }).catch(() => undefined)
    await browser.close()
  }
}
