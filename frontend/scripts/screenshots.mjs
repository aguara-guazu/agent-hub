/** Captura las pantallas de la consola contra una instancia ya levantada.
 *
 *  Requiere el control plane en :8000 y Vite en :5173 (make dev).
 *  Uso:  node scripts/screenshots.mjs [directorio-de-salida]
 *
 *  Falla con codigo distinto de cero si el navegador reporta errores de consola,
 *  asi sirve como verificacion y no solo como generador de imagenes.
 */
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const OUT = process.argv[2] ?? '/tmp/agenthub-shots'
const BASE = process.env.AGENTHUB_CONSOLE ?? 'http://127.0.0.1:5173'
const EMAIL = process.env.AGENTHUB_EMAIL ?? 'admin@craftech.io'
const PASSWORD = process.env.AGENTHUB_PASSWORD ?? 'agenthub'

const PAGES = [
  ['#/matrix', '02-matriz'],
  ['#/catalog', '03-catalogo'],
  ['#/skills', '04-skills'],
  ['#/machines', '05-maquinas'],
  ['#/users', '06-personas'],
  ['#/audit', '07-auditoria'],
]

mkdirSync(OUT, { recursive: true })

const errors = []
const DARK = process.env.THEME === 'dark'
const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 1600, height: 1000 },
  colorScheme: DARK ? 'dark' : 'light',
})
page.on('console', (m) => m.type() === 'error' && errors.push(`[console] ${m.text()}`))
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

const shot = async (name) => {
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/${name}${DARK ? '-dark' : ''}.png`, fullPage: true })
  console.log(`  ${name}${DARK ? '-dark' : ''}.png`)
}

await page.goto(`${BASE}/#/login`, { waitUntil: 'networkidle' })
await shot('01-login')

await page.fill('input[type=email], input[name=email], #email', EMAIL)
await page.fill('input[type=password], input[name=password], #password', PASSWORD)
await page.click('button[type=submit]')
await page.waitForTimeout(1500)

if (page.url().includes('/login')) {
  console.error('El login no avanzó: ¿está levantado el control plane y sembrada la base?')
  await browser.close()
  process.exit(1)
}

for (const [hash, name] of PAGES) {
  await page.goto(`${BASE}/${hash}`)
  await shot(name)
}

// El formulario de alta, con la sección de aislamiento desplegada: es donde se
// declara si un MCP server corre en contenedor o necesita la máquina.
await page.goto(`${BASE}/#/catalog`)
await page.waitForTimeout(700)
const nuevo = page.getByRole('button', { name: /Nuevo MCP server/i })
if (await nuevo.count()) {
  await nuevo.first().click()
  await page.waitForTimeout(500)
  await shot('08-alta-de-server')
}

await browser.close()

const unique = [...new Set(errors)]
console.log(`\nErrores de consola: ${unique.length}`)
unique.slice(0, 25).forEach((e) => console.log(`  ${e}`))
process.exit(unique.length === 0 ? 0 : 1)
