import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { buildReport, redactReport, LogFile, tailLog } from '../src/report.js'

it('filtra JSON, Bearer, Basic, tokens cortos y rutas codificadas de Windows', () => {
  const secret = 'private123'
  const text = redactReport(`{"refresh_token":"${secret}","client_secret":"abc"} Authorization: Bearer ${secret}\nBasic cHJpdmF0ZQ==\nfile:///C:/Users/Ana%20P%C3%A9rez/file\nana@example.com`, 'C:\\Users\\Ana Pérez')
  for (const value of [secret, 'abc', 'cHJpdmF0ZQ==', 'Ana', 'ana@example.com']) expect(text).not.toContain(value)
})
it('acota la URL aun con errores largos y filtra tanto título como cuerpo', () => {
  const report = buildReport({ title: 'Bearer private123', summary: 'fallo', error: 'x'.repeat(10000), environment: { Node: '24' }, logs: [] })
  expect(report.url.length).toBeLessThanOrEqual(7000)
  expect(report.title).not.toContain('private123')
  expect(new URL(report.url).searchParams.get('body')).toContain('Copiar reporte')
})
it('registra streams partidos, conserva el stack y rota por bytes sin crecer sin límite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'report-test-')), path = join(dir, 'worker.log')
  try {
    const log = new LogFile(path), stream = new PassThrough()
    log.follow(stream)
    stream.write('Authorization: Bear'); stream.end('er private123\n[job abc] Error\n[job abc] at function')
    await new Promise(resolve => stream.on('end', resolve))
    expect(readFileSync(path, 'utf8')).not.toContain('private123')
    expect(tailLog(path, 2).join('\n')).toContain('at function')
    for (let i = 0; i < 60; i++) log.write('á'.repeat(40_000))
    expect(statSync(path).size).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(statSync(`${path}.1`).size).toBeLessThanOrEqual(2 * 1024 * 1024)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
