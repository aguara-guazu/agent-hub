import { setProjectArchive } from '../src/projects/archive.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { z } from 'zod'
import { MemoryDatabase } from '../src/database.js'
import { MemoryStore } from '../src/store.js'
import { MemoryAI } from '../src/ai.js'
import { defaultAI, Vault } from '../src/config.js'
import { profile, localClock, type Evidence, type Watch } from '../src/assistants/contracts.js'
import { retrieve, projectModel, assessment, type AgentModel } from '../src/assistants/context.js'
import { inspectThread, channelAccess, type SlackRead } from '../src/assistants/slack.js'
import { Resident } from '../src/assistants/runtime.js'
import { projectSignals, pullRequests } from '../src/assistants/signals.js'
import { WorkQueue } from '../src/assistants/work.js'
import { normalizeJiraIssue } from '../src/projects/tasks.js'
import { channelWithinProject, discoverBindings } from '../src/assistants/portfolio.js'
import { compareClose } from '../src/assistants/close-shadow.js'
import { exportMemory, readBackup, restoreMemory } from '../src/backup.js'

let directory: string,
  db: MemoryDatabase,
  store: MemoryStore,
  ai: MemoryAI,
  vault: Vault,
  project: string,
  w: Watch,
  resident: Resident,
  root: string
let date: Date,
  thread: SlackRead,
  agents: boolean,
  conflict: boolean,
  failSend: boolean,
  receiptId: string,
  reads: string[],
  sends: string[]
let recentRoots: string[]
let respond: (input: any) => unknown
const message = '<@UOWNER> ¿confirmamos la entrega Atlas para el viernes?'
const stamp = (ms: number) => (ms / 1000).toFixed(6)
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hub-resident-'))
  db = new MemoryDatabase(join(directory, 'memory.sqlite'))
  await db.migrate()
  store = new MemoryStore(db, directory)
  vault = new Vault(directory)
  ai = new MemoryAI(async () => defaultAI, vault)
  project = (await store.create({ kind: 'project', title: 'Atlas' })).id
  date = new Date('2026-11-25T12:00:00Z')
  agents = false
  conflict = false
  failSend = false
  receiptId = ''
  reads = []
  sends = []
  w = { connector_id: randomUUID(), channel: 'CCLIENT', owner: 'UOWNER', team: 'TTEAM', colleagues: ['UPEER'] }
  root = stamp(+date - 660_000)
  recentRoots = [root]
  thread = inspectThread(w, root, [{ ts: root, user: 'UCLIENT', text: message }])
  await db.query("INSERT INTO connectors(id,provider,name,config,project_ids,enabled) VALUES($1,'slack','Slack',$2,$3,1)", [
    w.connector_id,
    { channel_ids: [w.channel] },
    [project],
  ])
  respond = (input) => ({
    relevant: true,
    status: conflict ? 'conflicting' : 'supported',
    explanation: conflict ? 'Las fuentes discrepan' : 'El viernes figura en el acuerdo de Atlas.',
    draft: 'Sí, el viernes.',
    urgency: 8,
    citations: (input.evidence as Evidence[]).map((e) => e.id),
  })
  const model: AgentModel = {
    async run<T>(_r, _id, _p, _policy, input, schema: z.ZodType<T>) {
      reads.push('model')
      return schema.parse(respond(input))
    },
  }
  resident = new Resident(
    db,
    model,
    async (id, text, exclude) => {
      reads.push('memory')
      return retrieve(db, ai, id, text, exclude)
    },
    async () => ({
      roots: async () => recentRoots,
      thread: async () => thread,
      send: async (_root, text, key) => {
        sends.push(text)
        receiptId = key
        if (failSend) throw Error('Sin acuse')
        return stamp(+date)
      },
    }),
    (id) => id !== 'agents' || agents,
    () => date,
  )
  await resident.save(project, profile.parse({ active: true, slack: [w], timezone: 'UTC', night_work: false }), 0)
})
afterEach(async () => {
  await resident?.stop()
  await db?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})
async function agreement(text = 'Atlas acordó la entrega para el viernes.') {
  return store.ingest({ kind: 'meeting', external_id: 'meeting-atlas', title: 'Reunión Atlas', text, project_ids: [project] })
}
async function first() {
  await agreement()
  await resident.scan(project)
  const settings = await resident.settings(project)
  expect(settings.last_error).toBeNull()
  const [item] = await resident.inbox(project)
  expect(item?.draft).toBe('Sí, el viernes.')
  return { item: item!, settings }
}
it('recupera memoria vigente del proyecto antes del primer borrador y entrega solo durante horario laboral', async () => {
  const other = (await store.create({ kind: 'project', title: 'Otro' })).id
  await store.ingest({
    kind: 'document',
    title: 'Otro cliente',
    external_id: 'other',
    text: 'Atlas entrega privada del otro cliente',
    project_ids: [other],
  })
  await store.ingest({
    provider: 'slack',
    account: w.connector_id,
    connector_id: w.connector_id,
    external_id: 'same',
    kind: 'message',
    title: 'Hilo',
    text: message,
    project_ids: [project],
    metadata: { channel: w.channel, thread_ts: root },
  })
  const { item } = await first()
  expect(reads.slice(0, 2)).toEqual(['memory', 'model'])
  expect(item.evidence.map((e) => e.title)).toEqual(['Reunión Atlas'])
  expect((await resident.notices())[0]).toMatchObject({ route: '/assistants/' + item.id, revision: item.revision })
  date = new Date('2026-11-25T20:00:00Z')
  expect(await resident.notices()).toEqual([])
  expect(sends).toEqual([])
})
it('conserva el asunto sin enviar si falta una fuente, hay conflicto o se ignora el aviso', async () => {
  await resident.scan(project)
  expect((await resident.inbox(project))[0]).toMatchObject({ draft: null, state: 'open' })
  conflict = true
  await agreement()
  await resident.scan(project)
  expect((await resident.inbox(project))[0]).toMatchObject({ draft: null, reason: expect.stringContaining('discrepan') })
  expect(sends).toEqual([])
})
it.each(['UOWNER', 'UPEER'])('descarta el borrador al encontrar la respuesta manual de %s en una lectura en vivo', async (user) => {
  const { item, settings } = await first()
  thread = inspectThread(w, root, [...thread.messages, { ts: stamp(+date), thread_ts: root, user, text: 'Ya lo vi' }])
  await expect(
    resident.attention.approve(item.id, item.revision, settings.config, settings.version, resident.signal(project)),
  ).rejects.toThrow('cambió')
  expect(await resident.attention.get(item.id)).toMatchObject({ state: 'handled', draft: null })
  expect(await resident.notices()).toEqual([])
  expect(sends).toEqual([])
})
it('envía solo una vez ante dos aceptaciones concurrentes de la misma revisión', async () => {
  const { item, settings } = await first()
  const approve = () => resident.attention.approve(item.id, item.revision, settings.config, settings.version, resident.signal(project))
  const results = await Promise.allSettled([approve(), approve()])
  expect(results.some((o) => o.status === 'fulfilled')).toBe(true)
  expect(await approve()).toMatchObject({ state: 'sent', receipt: stamp(+date) })
  expect(sends).toEqual(['Sí, el viernes.'])
})
it('invalida una aprobación cuando cambia la evidencia o se edita la pregunta', async () => {
  const { item, settings } = await first()
  const accept = (rev: number) => resident.attention.approve(item.id, rev, settings.config, settings.version, resident.signal(project))
  await agreement('Atlas cambió la entrega al lunes.')
  await expect(accept(item.revision)).rejects.toThrow('cambió')
  expect((await resident.attention.get(item.id)).draft).toBeNull()
  await resident.scan(project)
  const next = await resident.attention.get(item.id)
  thread = inspectThread(w, root, [{ ts: root, user: 'UCLIENT', text: message + ' ¿y el precio?', edited: { ts: stamp(+date) } }])
  await expect(accept(next.revision)).rejects.toThrow('cambió')
  expect(sends).toEqual([])
})
it('reconcilia una respuesta incierta por client_msg_id después de reiniciar sin repetirla', async () => {
  const { item, settings } = await first()
  failSend = true
  await expect(
    resident.attention.approve(item.id, item.revision, settings.config, settings.version, resident.signal(project)),
  ).rejects.toThrow()
  expect((await resident.attention.get(item.id)).state).toBe('uncertain')
  await resident.stop()
  thread = inspectThread(w, root, [
    ...thread.messages,
    { ts: stamp(+date), thread_ts: root, bot_id: 'BAPP', user: 'UAPP', text: 'Sí, el viernes.', client_msg_id: receiptId },
  ])
  await resident.scan(project)
  expect(await resident.attention.get(item.id)).toMatchObject({ state: 'sent', receipt: stamp(+date) })
  expect(sends).toHaveLength(1)
})
it('respeta la espera, conserva pendientes nocturnos y permite ensayar sin efectos', async () => {
  await agreement()
  date = new Date(+date - 5 * 60_000)
  await resident.scan(project)
  expect(await resident.inbox(project)).toHaveLength(0)
  date = new Date('2026-11-25T20:00:00Z')
  await resident.scan(project)
  expect(reads).not.toContain('model')
  date = new Date('2026-11-26T10:00:00Z')
  await resident.scan(project)
  const [item] = await resident.inbox(project)
  expect(item?.draft).toBeTruthy()
  const p = await resident.settings(project)
  expect(await resident.shadow(project, { ...p.config, threshold: 10 })).toMatchObject({
    current: [item!.id],
    proposed: [],
    external_sends: 0,
  })
  expect(sends).toEqual([])
  expect(localClock({ ...p.config, start: '22:00', end: '06:00', weekdays: [3] }, new Date('2026-11-26T02:00:00Z')).working).toBe(true)
})
it('incluye decisiones confirmadas, descarta notas obsoletas y respeta la privacidad en turnos concurrentes', async () => {
  await store.create({
    kind: 'fact',
    title: 'Decisión Atlas',
    data: { text: 'Entrega de Atlas', remote_processing: false },
    project_ids: [project],
  })
  await store.create({ kind: 'fact', title: 'Decisión vieja', data: { text: 'Atlas', stale: true }, project_ids: [project] })
  expect(await retrieve(db, ai, project, 'Atlas')).toEqual([expect.objectContaining({ title: 'Decisión Atlas', remote: false })])
  const origin = await store.create({
    kind: 'issue',
    title: 'DEV-91',
    data: { key: 'DEV-91', remote_processing: false },
    project_ids: [project],
  })
  await db.query(
    "INSERT INTO tasks(id,project_id,kind,title,status,external_key,source_entity_id,created_by,updated_by) VALUES($1,$2,'jira','Despliegue','in_progress','DEV-91',$3,'test','test')",
    [randomUUID(), project, origin.id],
  )
  expect(await retrieve(db, ai, project, 'DEV-91')).toContainEqual(expect.objectContaining({ title: 'DEV-91', remote: false }))
  await db.query("INSERT INTO settings(key,value) VALUES('ai',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [
    { ...defaultAI, extraction: 'deepseek', remote_processing_enabled: true },
  ])
  const model = projectModel(db, ai, () => true),
    p = profile.parse({ daily_turns: 1 })
  await expect(model.run('secretary', project, p, '', {}, assessment, false, new AbortController().signal)).rejects.toThrow('local')
  expect(await db.query('SELECT id FROM assistant_usage')).toHaveLength(0)
  await db.query("UPDATE settings SET value=$1 WHERE key='ai'", [{ ...defaultAI, extraction: 'ollama' }])
  const extract = vi.fn(async () => ({ value: {}, usage: { model: 'fixture', input_tokens: 10, output_tokens: 12 } }))
  vi.spyOn(ai, 'forJob').mockReturnValue({ extract } as unknown as MemoryAI)
  const call = () => model.run('secretary', project, p, '', {}, assessment, true, new AbortController().signal)
  await Promise.all([call(), call()])
  expect(extract).toHaveBeenCalledTimes(2)
  expect(await resident.work.estimates(project)).toMatchObject([{ samples: 2, median_tokens: null }])
})

it('recupera un envío interrumpido y restaura historial sin activar perfiles o microtareas antiguas', async () => {
  const { item, settings } = await first()
  await db.query("UPDATE assistant_cases SET state='sending',send_id=$2,sender_pid=NULL WHERE id=$1", [item.id, randomUUID()])
  await resident.attention.recover()
  expect(await resident.attention.get(item.id)).toMatchObject({ state: 'uncertain', draft: null })
  await resident.work.enqueue(
    project,
    settings.config,
    settings.version,
    { role: 'pm', objective: 'Preparar seguimiento', key: 'test/restore' },
    resident.signal(project),
  )
  const backup = JSON.parse(await readBackup(store, (await exportMemory(store)).id))
  const dest = await mkdtemp(join(tmpdir(), 'hub-assistant-restore-')),
    other = new MemoryDatabase(join(dest, 'memory.sqlite'))
  try {
    await other.migrate()
    await restoreMemory(new MemoryStore(other, dest), backup)
    expect(await other.query('SELECT config FROM assistant_profiles')).toMatchObject([{ config: { active: false } }])
    expect(await other.query('SELECT state FROM assistant_work')).toEqual([{ state: 'cancelled' }])
    expect(await other.query('SELECT state,draft FROM assistant_cases')).toEqual([{ state: 'uncertain', draft: null }])
    expect(await other.query('SELECT body FROM assistant_messages')).toHaveLength(1)
  } finally {
    await other.close()
    await rm(dest, { recursive: true, force: true })
  }
})
it('identifica dependencias de Jira en su dirección y quita reuniones canceladas', async () => {
  const ticket = (key: string, owner: string, links: unknown[] = []) => ({
    ...normalizeJiraIssue({ key, fields: { summary: key, status: 'En curso', duedate: '2026-11-24', assignee: { accountId: owner },
      issuelinks: links } }, 'https://atlas.atlassian.net')!, remote: true,
  })
  const tickets = [
    ticket('DEV-1', 'me', [
      { type: { inward: 'is blocked by' }, inwardIssue: { key: 'DEV-2' } },
      { type: { inward: 'is blocked by' }, inwardIssue: { key: 'EXT-3' } },
      { type: { inward: 'is blocked by' }, inwardIssue: { key: 'OLD-4', fields: { status: { statusCategory: { key: 'done' } } } } },
    ]),
    ticket('DEV-2', 'another'),
  ]
  await store.ingest({
    kind: 'event',
    external_id: 'review',
    title: 'Review Atlas',
    text: 'Demo',
    occurred_at: '2026-11-25T12:45:00Z',
    project_ids: [project],
  })
  const p = profile.parse({ jira_owner: 'me', timezone: 'UTC' }),
    signals = await projectSignals(db, project, p, date, tickets)
  expect(signals.find((s) => s.title.startsWith('DEV-2'))?.reasons).toContain('Bloquea tus tareas DEV-1')
  expect(signals.find((s) => s.title.startsWith('DEV-1'))?.reasons).toContain('Jira marca como dependencias de tu tarea DEV-2, EXT-3')
  expect(signals.find((s) => s.kind === 'meeting')?.score).toBe(8)
  await db.query("UPDATE entities SET data=json_set(data,'$.status','cancelled') WHERE kind='event'")
  expect((await projectSignals(db, project, p, date)).some((s) => s.kind === 'meeting')).toBe(false)
})
it('una actualización del cliente conserva la hora inicial de la mención mientras siga sin atención', () => {
  const update = inspectThread(w, root, [
    ...thread.messages,
    { ts: stamp(+date - 60_000), user: 'UCLIENT', text: 'Te pasamos el archivo.' },
  ])
  expect(update.signal).toMatchObject({ at: new Date(Number(root) * 1000).toISOString(), source: { mention: true } })
})
it('encuentra revisiones solicitadas y checks fallidos propios en el SHA observado', async () => {
  const shared = {
    number: 25,
    title: 'DEV-10 entregas',
    headRefName: 'DEV-10',
    headRefOid: '1'.repeat(40),
    isDraft: false,
    updatedAt: date.toISOString(),
    url: 'https://github.com/example/demo/pull/25',
    reviewRequests: [],
    reviewDecision: '',
    statusCheckRollup: [],
    author: { login: 'other' },
  }
  const gh = vi.fn(async (argv: string[]) =>
    argv[0] === 'api'
      ? 'Owner'
      : JSON.stringify(
          argv.includes('--search')
            ? [{ ...shared, reviewRequests: [{ login: 'owner' }] }]
            : [{ ...shared, number: 26, author: { login: 'owner' }, statusCheckRollup: [{ conclusion: 'FAILURE' }] }],
        ),
  )
  const items = await pullRequests('example/demo', new AbortController().signal, gh)
  expect(items.map((i) => i.score).sort()).toEqual([6, 8])
  expect(items.every((i) => i.source.sha === shared.headRefOid)).toBe(true)
})
it('comprueba el canal, cuenta y exclusiones otra vez al enviar', async () => {
  vault.save(w.connector_id, { token: 'fixture-only' })
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, user_id: w.owner, team_id: w.team })))
  const access = await channelAccess(db, vault, project, w, () => true, new AbortController().signal, fetcher)
  await db.query("UPDATE connectors SET config='{}' WHERE id=$1", [w.connector_id])
  await expect(access.send(root, 'Hola', randomUUID())).rejects.toThrow('canal')
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('desarrollo conserva el checkout original, verifica el SHA y puede reanudar el resultado del paso confirmado', async () => {
  const repo = join(directory, 'repo')
  await mkdir(repo)
  const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git(['init', '--quiet'])
  await writeFile(join(repo, 'count.js'), 'export const count = 1\n')
  git(['add', 'count.js'])
  git(['-c', 'user.name=Test', '-c', 'user.email=dev@localhost', 'commit', '-qm', 'base'])
  const base = git(['rev-parse', 'HEAD'])
  await db.query("UPDATE entities SET data=json_set(data,'$.folders',json($2)) WHERE id=$1", [project, [repo]])
  const p = profile.parse({
    active: true,
    repository: repo,
    files: ['count.js'],
    verify: process.platform === 'darwin' ? [process.execPath, '--check', 'count.js'] : [],
    timezone: 'UTC',
  })
  await resident.save(project, p, 1)
  agents = true
  let turns = 0
  respond = () => {
    turns++
    return {
      ready: true,
      criteria: ['count vale 2'],
      summary: 'Actualicé count.',
      changes: [{ path: 'count.js', before: 'count = 1', after: 'count = 2' }],
    }
  }
  const job = await resident.work.enqueue(
    project,
    p,
    2,
    { role: 'developer', key: 'owner/check', objective: 'Cambiar count a 2' },
    resident.signal(project),
  )
  await resident.work.next(project, p, 2, resident.signal(project))
  const [row] = await db.query('SELECT * FROM assistant_work WHERE id=$1', [job!.id])
  expect(row?.state, JSON.stringify(row?.result)).toBe('done')
  expect(row?.result).toMatchObject({ base, sha: expect.stringMatching(/^[a-f\d]{40,64}$/), verified: true })
  expect(await readFile(join(repo, 'count.js'), 'utf8')).toBe('export const count = 1\n')
  expect(git(['show', row!.result.sha + ':count.js'])).toBe('export const count = 2')
  await db.query("UPDATE assistant_work SET state='running' WHERE id=$1", [job!.id])
  await resident.work.recover()
  await resident.work.next(project, p, 2, resident.signal(project))
  expect(turns).toBe(1)
})

it('asesora desde el chat, delega con memoria y entrega el resultado al volver al horario laboral', async () => {
  agents = true
  await agreement()
  respond = (input) =>
    input.history
      ? { reply: 'PM va a preparar el seguimiento.', delegate: { role: 'pm', objective: 'Preparar la revisión de Atlas' } }
      : {
          summary: 'La revisión abarca la entrega del viernes.',
          criteria: ['Confirmar fecha'],
          missing: [],
          citations: input.evidence.map((e: Evidence) => e.id),
          delegate: [],
        }
  const answer = await resident.chat(project, null, 'Delegá la preparación de Atlas', 'chat', undefined, randomUUID())
  expect(answer.messages.map((m) => m.role)).toEqual(['owner', 'secretary'])
  const [queued] = await db.query('SELECT * FROM assistant_work')
  expect(queued).toMatchObject({ role: 'pm', state: 'queued' })
  const settings = await resident.settings(project)
  await resident.work.next(project, settings.config, settings.version, resident.signal(project))
  expect((await resident.conversation(project, null)).messages.at(-1)).toMatchObject({ role: 'pm' })
  date = new Date('2026-11-25T22:00:00Z')
  expect(await resident.notices()).toEqual([])
  date = new Date('2026-11-26T09:00:00Z')
  expect(await resident.notices()).toContainEqual(expect.objectContaining({ id: queued!.id, route: '/assistants?project=' + project }))
})
it('mantiene un compromiso propio como microtarea y deduplica las lecturas sucesivas', async () => {
  const { item } = await first()
  agents = true
  thread = inspectThread(w, root, [...thread.messages, { ts: stamp(+date), user: w.owner, text: 'Lo reviso mañana y te aviso.' }])
  respond = () => ({ summary: 'Seguimiento de la respuesta de mañana.', criteria: [], missing: [], citations: [], delegate: [] })
  await resident.scan(project)
  await resident.scan(project)
  expect(await resident.attention.get(item.id)).toMatchObject({ state: 'handled', draft: null })
  expect(await db.query("SELECT id FROM assistant_work WHERE request_key LIKE 'followup/%'")).toHaveLength(1)
})
it('ofrece al modelo sólo identificadores de fuentes verificadas para las citas de una microtarea', async () => {
  const source = { id: 'jira/https://atlas.atlassian.net/AT-2', title: 'AT-2', text: 'En curso', url: 'https://atlas.atlassian.net/browse/AT-2', at: date.toISOString(), remote: true }
  const model = vi.spyOn(resident.model, 'run')
  const queue = new WorkQueue(db, resident.model, async () => [source], directory)
  const p = await resident.settings(project)
  const job = await queue.enqueue(project, p.config, p.version, { role: 'pm', objective: 'Revisar la entrega', key: 'attention/test' }, resident.signal(project))
  const reply = { summary: 'En curso', criteria: [], missing: [], citations: [source.id], delegate: [] }
  respond = () => reply
  await queue.next(project, p.config, p.version, resident.signal(project))
  const schema = model.mock.lastCall![5]
  expect(schema.safeParse(reply).success).toBe(true)
  expect(schema.safeParse({ ...reply, citations: [source.url] }).success).toBe(false)
  expect((await db.query('SELECT state,result FROM assistant_work WHERE id=$1', [job!.id]))[0])
    .toMatchObject({state: 'done', result: {evidence: [source]}})
})
it('el comparador reutiliza una sola captura del cierre sin crear entregas ni intenciones', async () => {
  const activated = vi.fn(async () => [{ project_id: project, ref: project, summary: 'Atlas', at: date.toISOString() }])
  const preview = await compareClose(store, project, date, async () => [project], { activated_projects: activated }, undefined, {
    current: null,
    proposed: null,
    delivery: ['slack_self'],
  })
  expect(activated).toHaveBeenCalledTimes(1)
  expect(preview).toMatchObject({ current: { delivery: [] }, proposed: { delivery: ['slack_self'] }, external_sends: 0 })
  expect(preview.current.body).toBe(preview.proposed.body)
  expect(await db.query('SELECT id FROM schedule_deliveries')).toHaveLength(0)
})
it('el hilo conserva las preguntas humanas cuando un bot comenta y reconoce respuestas enlazadas desde el canal', async () => {
  const bot = { ts: stamp(+date - 2_000), bot_id: 'BOTHER', text: 'Updated issue' }
  const rootMessage = thread.messages[0]!
  expect(inspectThread(w, root, [rootMessage, bot]).signal?.text).toBe(message)
  vault.save(w.connector_id, { token: 'fixture' })
  const channelReply = {
    ts: stamp(+date),
    user: w.owner,
    text: 'Confirmado en <https://team.slack.com/archives/' + w.channel + '/p' + root.replace('.', '') + '>',
  }
  const fetcher = vi.fn(async (raw: string | URL | Request) => {
    const method = new URL(String(raw)).pathname.split('/').at(-1)
    return Response.json(
      method === 'auth.test'
        ? { ok: true, team_id: w.team, user_id: w.owner }
        : { ok: true, messages: method === 'conversations.history' ? [channelReply] : [rootMessage, bot] },
    )
  })
  const channel = await channelAccess(db, vault, project, w, () => true, new AbortController().signal, fetcher)
  expect(await channel.thread(root, true)).toMatchObject({ handled: true, signal: null })
})

it('sigue proyectos existentes y nuevos sin configurarlos, ordena la bandeja global y omite los archivados', async () => {
  const create = async (title: string, delay: number) => {
    const p = await store.create({ kind: 'project', title })
    await store.ingest({ kind: 'event', external_id: p.id, title, occurred_at: new Date(+date + delay).toISOString(), project_ids: [p.id] })
    return p.id
  }
  const firstId = await create('Primero', 7200000)
  const archived = await create('Archivado', 100000)
  await db.query("UPDATE entities SET data=json_set(data,'$.memory_state','archived') WHERE id=$1", [archived])
  await resident.tick()
  expect((await resident.settings(firstId)).last_scan).toBeTruthy()
  const newId = await create('Nuevo', 300000)
  await resident.tick()
  const relevant = (await resident.inbox()).filter((i) => [firstId, newId, archived].includes(i.project_id))
  expect(relevant.map((i) => i.project_id)).toEqual([newId, firstId])
  expect(await resident.projects()).not.toContainEqual(expect.objectContaining({ id: archived }))
  expect((await resident.notices()).flatMap(n=>n.entries.map(e=>e.route))).toContain('/assistants/' + relevant[0]!.id)
})

it('propaga una sola preferencia a proyectos existentes y futuros y preserva sus destinos y pausas explícitas', async () => {
  const a = await resident.settings(project)
  const other = (await store.create({ kind: 'project', title: 'En pausa' })).id
  await resident.save(other, profile.parse({ active: false }), 0)
  const initial = await resident.policy()
  const updated = await resident.setPolicy({ ...initial.config, threshold: 9 }, initial.version)
  expect(updated.version).toBe(1)
  await expect(resident.setPolicy(initial.config, 0)).rejects.toThrow('Otra sesión')
  const next = (await store.create({ kind: 'project', title: 'Creado después' })).id
  await resident.tick()
  expect((await resident.settings(next)).config).toMatchObject({ active: true, threshold: 9 })
  expect((await resident.settings(other)).config).toMatchObject({ active: false, threshold: 9 })
  expect(await resident.settings(project)).toMatchObject({ version: a.version + 1, config: { slack: [w], threshold: 9 } })
  expect((await resident.policy()).version).toBe(1)
})

it('descubre canales y repositorios autorizados desde una única conexión y descarta asociaciones ambiguas', async () => {
  const second = await store.create({ kind: 'project', title: 'Proyecto Boreal', data: { repo_url: 'git@github.com:equipo/boreal.git' } })
  await resident.settings(second.id)
  const id = randomUUID()
  await db.query("INSERT INTO connectors(id,provider,name,config,project_ids,enabled) VALUES($1,'slack','Cuenta',$2,'[]',1)", [
    id,
    { channel_ids: ['CBOREAL'] },
  ])
  const identity = {
    slack: async () => ({ team: 'TTEAM', owner: 'UOWNER' }),
    jira: async () => 'jira-dueño',
    channelName: async () => 'ext-proyecto-boreal',
  }
  const find = async () => (await discoverBindings(db, identity, true)).find((p) => p.id === second.id)!.bindings
  expect(await find()).toMatchObject({
    slack: [{ connector_id: id, channel: 'CBOREAL', owner: 'UOWNER' }],
    github_repos: ['equipo/boreal'],
    jira_owner: 'jira-dueño',
  })
  expect(await channelWithinProject(db, second.id, id, 'CBOREAL', identity.channelName)).toBe(true)
  expect(await channelWithinProject(db, project, id, 'CBOREAL', identity.channelName)).toBe(false)
  const twin = await store.create({ kind: 'project', title: 'Otro', data: { cliente: 'Proyecto Boreal' } })
  await resident.settings(twin.id)
  expect((await find()).slack).toEqual([])
  expect(await channelWithinProject(db, second.id, id, 'CBOREAL', identity.channelName)).toBe(false)
  await db.query('UPDATE connectors SET enabled=0 WHERE id=$1', [id])
  expect(await channelWithinProject(db, second.id, id, 'CBOREAL')).toBe(false)
})

it('mantiene el chat global tras reiniciar, busca memoria antes de responder y aplica privacidad de todos los proyectos', async () => {
  const other = await store.create({ kind: 'project', title: 'Privado', data: { remote_processing: false } })
  await agreement()
  await store.ingest({
    kind: 'document',
    external_id: 'priv',
    title: 'Entrega Privado',
    text: 'El viernes hay una entrega.',
    project_ids: [other.id],
  })
  const calls = vi.spyOn(resident.model, 'run')
  respond = () => ({ reply: 'Hay dos entregas para revisar.' })
  const answer = await resident.overview('¿Qué entregas hay el viernes?')
  expect(answer.messages.at(-1)?.body).toContain('dos entregas')
  expect(reads.indexOf('memory')).toBeLessThan(reads.indexOf('model'))
  expect(calls.mock.calls.at(-1)?.[6]).toBe(false)
  expect(answer.messages.at(-1)?.evidence.map((e: Evidence) => e.title)).toEqual(
    expect.arrayContaining([expect.stringContaining('Atlas'), expect.stringContaining('Privado')]),
  )
  const next = new Resident(db, resident.model, resident.lookup, resident.attention.access, () => true)
  expect((await next.overview()).messages).toHaveLength(2)
  expect(sends).toEqual([])
  await next.stop()
})

it('descubre el remoto GitHub desde carpetas Git registradas sin configurar un repositorio en el asistente', async () => {
  const folder = join(directory, 'carpeta registrada')
  await mkdir(folder)
  execFileSync('git', ['init', '--quiet', folder])
  execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', 'git@github.com:equipo/desarrollo.git'])
  const p = await store.create({
    kind: 'project',
    title: 'Desarrollo externo',
    data: { folders: [folder, join(directory, 'inexistente')] },
  })
  await resident.settings(p.id)
  const bindings = await discoverBindings(db, resident.identities, true)
  expect(bindings.find((b) => b.id === p.id)?.bindings.github_repos).toEqual(['equipo/desarrollo'])
})

it('omite un proyecto archivado de la sesión global y lo vuelve a evaluar al reactivarlo', async () => {
  await resident.tick()
  await setProjectArchive(store, project, { state: 'archived', version: 0 })
  expect(await resident.projects()).toEqual([])
  expect(await resident.notices()).toEqual([])
  await expect(resident.scan(project)).rejects.toThrow('pausado')
  await setProjectArchive(store, project, { state: 'active', version: 1 })
  expect((await resident.projects()).map(p => p.id)).toContain(project)
  await resident.scan(project)
  expect((await resident.settings(project)).last_scan).toBeTruthy()
})

it.each([true, false])('al desarchivar revisa una mención antigua una sola vez según si ya fue respondida (%s)', async handled => {
  const { item } = await first()
  await setProjectArchive(store, project, {state:'archived',version:0})
  date = new Date(+date + 7*24*60*60*1000)
  recentRoots = []
  if (handled) thread = inspectThread(w, root, [{ts:root,user:'UCLIENT',text:message},{ts:stamp(+date-5_000),user:w.owner,text:'Sí, confirmado.'}])
  await setProjectArchive(store, project, {state:'active',version:1})
  await resident.scan(project)
  const alerts = await resident.notices()
  expect(alerts.map(alert => alert.id)).toEqual(handled ? [] : [item.id])
  await setProjectArchive(store, project, {state:'active',version:1})
  await resident.scan(project)
  expect(await resident.notices()).toEqual(alerts)
})

it('contesta las dos entradas de chat sobre el asunto elegido sin consultar otros pendientes', async () => {
  const issue = async (key: string) => {
    const id = randomUUID()
    await db.query(`INSERT INTO assistant_cases(id,project_id,source_key,kind,title,score,reason,state,source,fingerprint,notify_after,updated_at)
      VALUES($1,$2,$3,'jira',$4,7,'Motivo observado','open',$5,'f',now(),now())`,
      [id, project, 'jira/' + id, key + ' · Entrega', { url: 'https://atlas.atlassian.net/browse/' + key, issue_key: key }])
    return id
  }
  const focus = await issue('NIN-87')
  const other = await issue('NIN-86')
  await db.query(`INSERT INTO assistant_overview_messages(role,body,projects,case_id,created_at)
    VALUES('owner','Otra pregunta sobre NIN-86',$1,$2,now())`, [[project], other])
  const inputs: any[] = []
  respond = input => { inputs.push(input); return { reply: 'Consulté NIN-87.' } }
  expect((await resident.overview({ text: '¿Qué pasó con este pendiente?', caseId: focus })).messages.at(-1)?.body).toBe('Consulté NIN-87.')
  expect((await resident.chat(project, focus, '¿Quién figura asignado?', 'chat')).messages.at(-1)?.body).toBe('Consulté NIN-87.')
  for (const input of inputs) {
    expect(JSON.stringify(input)).toContain('https://atlas.atlassian.net/browse/NIN-87')
    expect(JSON.stringify(input)).not.toContain('NIN-86')
    expect(input.case.id).toBe(focus)
  }
  respond = () => { throw Error('La terminal no respondió') }
  for (const answer of [await resident.overview({ text: '¿Y ahora?', caseId: focus }), await resident.chat(project, focus, '¿Y ahora?', 'chat')]) {
    expect(answer.messages.at(-1)?.body).toContain('La terminal no respondió')
    expect(answer.messages.at(-1)?.body).toContain('NIN-87')
    expect(answer.messages.at(-1)?.body).not.toContain('NIN-86')
  }
})

it('la microtarea seleccionada conserva su propio contexto aunque no tenga un asunto de origen', async () => {
  agents = true
  const target = await resident.settings(project)
  const make = (objective: string) => resident.work.enqueue(project, target.config, target.version,
    { key: randomUUID(), role: 'pm', objective }, resident.signal(project))
  const job = await make('Confirmar la entrega de Atlas')
  await make('Un trabajo ajeno a la consulta')
  let input: any
  respond = value => { input = value; return { reply: 'La microtarea está en cola.' } }
  const answer = await resident.overview({ text: '¿En qué quedó esto?', workId: job!.id })
  expect(input.work).toMatchObject({ id: job!.id, objective: job!.objective, state: 'queued' })
  expect(JSON.stringify(input)).not.toContain('Un trabajo ajeno')
  expect(answer.messages.at(-2)).toMatchObject({ work_id: job!.id, case_title: job!.objective })
})

it('un perfil y una política antiguos permiten superar los 24 turnos del día y conservan la contabilidad', async () => {
  await db.query("INSERT INTO settings(key,value) VALUES('ai',$1)", [{ ...defaultAI, extraction: 'ollama' }])
  const model = projectModel(db, ai, () => true)
  const p = profile.parse({ daily_turns: 1 })
  vi.spyOn(ai, 'forJob').mockReturnValue({ extract: async () => ({
    value: { reply: 'Respuesta' }, usage: { model: 'fixture', input_tokens: 8, output_tokens: 3 }
  }) } as unknown as MemoryAI)
  const run = (owner: boolean) => model.run('secretary', project, p, 'Consulta', {}, assessment, true, resident.signal(project), { owner })
  await db.query("INSERT INTO assistant_portfolio_policy(singleton,value) VALUES(1,$1)", [{version: 1, config: {daily_turns: 24}}])
  for (let turn = 0; turn < 25; turn++) await run(false)
  await expect(run(true)).resolves.toMatchObject({ reply: 'Respuesta' })
  await expect(run(false)).resolves.toMatchObject({ reply: 'Respuesta' })
  expect(await db.query('SELECT owner_turn,count(*) AS n FROM assistant_usage GROUP BY owner_turn ORDER BY owner_turn'))
    .toEqual([{owner_turn: false, n: 26}, {owner_turn: true, n: 1}])
  expect((await resident.policy()).config).not.toHaveProperty('daily_turns')
  expect(await resident.modelStatus()).not.toHaveProperty('budget_spent')
})

it('resuelve en Jira la clave escrita en el chat aunque el ticket ya no esté en la bandeja', async () => {
  await db.query("UPDATE entities SET data=json_set(data,'$.jira_project_key','NIN') WHERE id=$1", [project])
  await store.create({ kind: 'project', title: 'Otro proyecto', data: { jira_project_key: 'OTHER', remote_processing: false } })
  const live = vi.spyOn(resident, 'liveEvidence').mockResolvedValue({
    status: 'not_visible', evidence: [], detail: 'NIN-87 no figura entre los tickets visibles en Jira.', remote: true,
  })
  let input: any
  respond = value => { input = value; return { reply: value.verification?.detail ?? 'Sin consulta' } }
  const result = await resident.overview('¿Sigue existiendo NIN-87?')
  expect(result.messages.at(-1)).toMatchObject({ body: expect.stringContaining('no figura'), case_title: 'NIN-87' })
  expect(live).toHaveBeenCalledWith(project, null, expect.stringContaining('NIN-87'), expect.any(AbortSignal))
  expect(JSON.stringify(input)).not.toContain('Otro proyecto')
})
