#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'

const usage =
  'npm run assistants -- projects | settings [archivo] | overview [texto] | inbox [project] | watch [--ack] | config PROJECT [file] | scan [PROJECT] | chat PROJECT "texto" [caso] | approve CASO REVISION | delegate PROYECTO ROL "objetivo"'
async function main(args: string[]) {
  const [action, target, value, extra] = args
  if (!action || action === '--help') {
    console.log(usage)
    return
  }
  const base = new URL(process.env.AGENTHUB_URL || 'http://127.0.0.1:8765')
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)))
    throw new Error('Usá HTTPS o la interfaz local')
  let token = process.env.AGENTHUB_ACCESS_TOKEN
  const bootstrap = process.env.AGENTHUB_DESKTOP_BOOTSTRAP_TOKEN
  const signal = AbortSignal.timeout
  async function session() {
    if (!bootstrap) throw new Error('Configurá AGENTHUB_ACCESS_TOKEN o el bootstrap del dueño')
    const r = await fetch(new URL('/api/auth/desktop-session', base), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + bootstrap },
      redirect: 'error',
      signal: signal(15000),
    })
    if (!r.ok) throw new Error('Sesión rechazada (' + r.status + ')')
    token = ((await r.json()) as { access_token: string }).access_token
  }
  const call = async (path: string, method = 'GET', body?: unknown) => {
    if (!token) await session()
    const request = () =>
      fetch(new URL('/api/assistants/' + path, base), {
        method,
        redirect: 'error',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal(300000),
      })
    let r = await request()
    if (r.status === 401 && bootstrap) {
      await session()
      r = await request()
    }
    const result = (await r.json()) as Record<string, any>
    if (!r.ok) throw new Error(result.detail || result.message || 'HTTP ' + r.status)
    return result
  }
  const id = (s: string | undefined) => {
    if (!s || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(s)) throw new Error(usage)
    return s
  }
  const emit = (value: unknown) => console.log(JSON.stringify(value))
  switch (action) {
    case 'projects':
      return emit(await call('projects'))
    case 'settings':
      return emit(target ? await call('settings', 'PUT', JSON.parse(await readFile(target, 'utf8'))) : await call('settings'))
    case 'overview':
      return emit(target ? await call('chat', 'POST', { text: target }) : await call('chat'))
    case 'inbox':
      return emit(await call('inbox' + (target ? '?project=' + id(target) : '')))
    case 'scan':
      return emit(await call(target ? 'projects/' + id(target) + '/scan' : 'scan', 'POST', {}))
    case 'config': {
      const path = 'projects/' + id(target)
      if (!value) return emit(await call(path))
      const config = JSON.parse(await readFile(value, 'utf8')) as { version: number; config: unknown }
      return emit(await call(path, 'PUT', { version: config.version, config: config.config }))
    }
    case 'chat':
      return emit(
        await call('projects/' + id(target) + '/chat', 'POST', {
          text: value,
          case_id: extra ? id(extra) : null,
          request_id: randomUUID(),
        }),
      )
    case 'approve':
      return emit(await call('slack/' + id(target) + '/approve', 'POST', { revision: Number(value) }))
    case 'delegate':
      return emit(await call('work/' + id(target), 'POST', { role: value, objective: extra, request_id: randomUUID() }))
    case 'watch': {
      const ack = args.includes('--ack'),
        seen = new Set<string>(),
        consumer = randomUUID()
      let presented: { id: string; revision: number; delivery_id?: string } | undefined
      for (;;) {
        try {
          if (presented) {
            await call('notices/' + id(presented.id) + '/seen', 'POST', {
              revision: presented.revision,
              delivery_id: presented.delivery_id,
            })
            presented = undefined
          }
          const { items } = ack ? await call('notices/claim', 'POST', { consumer }) : await call('notices')
          for (const notice of items) {
            const key = notice.delivery_id ?? notice.id + '/' + notice.revision
            if (!seen.has(key)) {
              emit({ ...notice, url: new URL('/#' + notice.route, base).href })
              seen.add(key)
            }
            if (ack) {
              presented = notice
              await call('notices/' + id(notice.id) + '/seen', 'POST', { revision: notice.revision, delivery_id: notice.delivery_id })
              presented = undefined
            }
          }
          const current = new Set(
            items.map((n: { id: string; revision: number; delivery_id?: string }) => n.delivery_id ?? n.id + '/' + n.revision),
          )
          for (const key of seen) if (!current.has(key)) seen.delete(key)
        } catch (e) {
          console.error(e instanceof Error ? e.message : 'El Hub no respondió')
        }
        await wait(15000)
      }
    }
    default:
      throw new Error(usage)
  }
}
main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
