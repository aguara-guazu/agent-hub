// Measures the compiled memory implementation on a private snapshot; never writes to the input DB.
import { DatabaseSync, backup } from 'node:sqlite'
import { mkdtemp, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { MemoryDatabase, vectorValues } from '../packages/memory/dist/database.js'
import { searchMemory } from '../packages/memory/dist/search.js'
import { globalSearch } from '../packages/memory/dist/global-search.js'
import { MemoryError } from '../packages/memory/dist/contracts.js'

const args = process.argv.slice(2)
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const input = option('--database'), runs = Number(option('--runs', '5'))
if (!input || !Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('Uso: node scripts/benchmark-memory.mjs --database /ruta/memory.sqlite [--runs 5]')
const directory = await mkdtemp(join(tmpdir(), 'agenthub-benchmark-'))
let db
try {
  const source = new DatabaseSync(resolve(input), { readOnly: true })
  const file = join(directory, 'memory.sqlite')
  try { await backup(source, file) } finally { source.close() }
  await chmod(file, 0o600)
  db = new MemoryDatabase(file); await db.migrate()
  const [sample] = await db.query('SELECT model,embedding FROM embeddings LIMIT 1')
  const offline = { embedQuery: async () => { throw new MemoryError(409, 'benchmark sin embeddings') } }
  const fixed = sample ? { embed: async () => ({ model: sample.model, vectors: [vectorValues(sample.embedding)] }),
    embedQuery: async () => ({ model: sample.model, vectors: [vectorValues(sample.embedding)] }) } : null
  const scenarios = [
    ['fragment_text', () => searchMemory(db, offline, { query: 'arquitectura', mode: 'text' })],
    ['fragment_common', () => searchMemory(db, offline, { query: 'proyecto', mode: 'text' })],
    ['global_text', () => globalSearch(db, offline, { query: 'arquitectura' })],
    ...(fixed ? [['fragment_semantic', () => searchMemory(db, fixed, { query: 'fixture', mode: 'semantic' })],
      ['global_hybrid', () => globalSearch(db, fixed, { query: 'arquitectura' })]] : []),
  ]
  const measurements = []
  for (const [name, query] of scenarios) {
    await query() // Warm caches once, separately from the measured samples.
    const samples = []; let total = 0
    for (let i = 0; i < runs; i++) { const start = performance.now(); const result = await query(); samples.push(Math.round(performance.now() - start)); total = result.total }
    const ordered = [...samples].sort((a, b) => a - b)
    measurements.push({ name, samples_ms: samples, median_ms: ordered[Math.floor(ordered.length / 2)], total })
  }
  console.log(JSON.stringify({ node: process.version, embedding: 'fixed stored vector; excludes inference/network', measurements }, null, 2))
} finally { await db?.close(); await rm(directory, { recursive: true, force: true }) }
