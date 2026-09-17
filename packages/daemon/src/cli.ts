#!/usr/bin/env node
/**
 * Interfaz de línea de comandos del daemon (`agenthub`).
 *
 * Este módulo solo parsea argumentos y escribe en la terminal. El comportamiento
 * vive en `app.ts`.
 *
 *     agenthub enroll --url http://hub.interno --email persona@craftech.io
 *     agenthub sync --once
 *     agenthub status
 *     agenthub plan
 *     agenthub why mcp__hub__ops_restart_service
 *     agenthub run
 *     agenthub gateway --agent <agent_instance_id>
 *
 * El token nunca se imprime. Y `gateway` es el único cuyo stdout es el protocolo MCP:
 * ese comando lo sirve `@agenthub/gateway`; acá se limita a señalarlo.
 */

import { runHeadless } from '@agenthub/gateway'

import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'

import {
  DaemonApp,
  DaemonError,
  detectClis,
  diffFor,
  normalizeToolName,
  type AgentPass,
  type SyncReport,
} from './app.js'
import { loadConfig } from './config.js'
import { ControlPlaneError, DEFAULT_MAX_ATTEMPTS } from './sync.js'
import { DaemonState } from './state.js'

export const EXIT_OK = 0
export const EXIT_ERROR = 1

const COMMAND_ATTEMPTS: Record<string, number> = {
  enroll: 1,
  run: DEFAULT_MAX_ATTEMPTS,
  sync: 2,
  plan: 2,
  status: 1,
  why: 1,
  gateway: 1,
}

interface ParsedArgs {
  command: string
  home?: string
  stateDir?: string
  url?: string
  verbose: boolean
  email?: string
  password?: string
  token?: string
  hostname?: string
  tool?: string
  agent?: string
  once: boolean
  local: boolean
  maxCycles: number
  retries?: number
}

function say(text = ''): void {
  process.stdout.write(text + '\n')
}

function warn(text: string): void {
  process.stderr.write(text + '\n')
}

const LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex_cli: 'Codex CLI',
  gemini_cli: 'Gemini CLI',
  kiro: 'Kiro',
  claude_desktop: 'Claude Desktop',
  opencode: 'OpenCode',
}

function label(cliKind: string): string {
  return LABELS[cliKind] ?? cliKind
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { command: argv[0] ?? '', verbose: false, once: false, local: false, maxCycles: 0 }
  const take = (i: number): string => argv[i] ?? ''
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!
    switch (arg) {
      case '--home':
        args.home = take(++i)
        break
      case '--state-dir':
        args.stateDir = take(++i)
        break
      case '--url':
        args.url = take(++i)
        break
      case '-v':
      case '--verbose':
        args.verbose = true
        break
      case '--email':
        args.email = take(++i)
        break
      case '--password':
        args.password = take(++i)
        break
      case '--token':
        args.token = take(++i)
        break
      case '--hostname':
        args.hostname = take(++i)
        break
      case '--agent':
        args.agent = take(++i)
        break
      case '--once':
        args.once = true
        break
      case '--local':
        args.local = true
        break
      case '--max-cycles':
        args.maxCycles = Number.parseInt(take(++i) || '0', 10)
        break
      case '--retries':
        args.retries = Number.parseInt(take(++i) || '0', 10)
        break
      default:
        if (!arg.startsWith('-') && args.command === 'why' && args.tool === undefined) args.tool = arg
    }
  }
  return args
}

function attemptsFor(args: ParsedArgs): number {
  if (args.retries !== undefined) return Math.max(1, args.retries)
  return COMMAND_ATTEMPTS[args.command] ?? DEFAULT_MAX_ATTEMPTS
}

function buildApp(args: ParsedArgs): DaemonApp {
  const home = args.home ? expand(args.home) : undefined
  const stateDir = args.stateDir ? expand(args.stateDir) : undefined

  const probe = loadConfig({ ...(stateDir ? { stateDir } : {}), ...(home ? { home } : {}) })
  const stored = new DaemonState(probe.stateDir).loadCredentials()
  const config = loadConfig({
    controlPlaneUrl: args.url || (stored ? stored.controlPlaneUrl : ''),
    ...(stateDir ? { stateDir } : {}),
    ...(home ? { home } : {}),
  })
  return new DaemonApp(config, { maxAttempts: attemptsFor(args) })
}

function expand(path: string): string {
  return path.startsWith('~') ? homedir() + path.slice(1) : path
}

function describePass(item: AgentPass): string {
  if (item.skipped) return item.skipped
  if (item.applied !== null) {
    const parts = [`${item.applied.written.length} archivos escritos`]
    if (item.applied.removed.length > 0) parts.push(`${item.applied.removed.length} borrados`)
    if (item.applied.drift.length > 0) parts.push(`${item.applied.drift.length} con deriva, sin pisar`)
    return parts.join(', ')
  }
  if (item.changes.length > 0) return `${item.changes.length} cambios pendientes`
  return 'sin cambios'
}

function where(app: DaemonApp, item: AgentPass): string {
  return app.stdioGateway ? 'stdio' : `puerto ${item.port}`
}

function printSync(app: DaemonApp, report: SyncReport, applied: boolean): void {
  if (report.bootstrapError) {
    warn(`modo degradado: el control plane no contesta (${report.bootstrapError}). Se usa el último estado en disco.`)
  }
  if (report.agents.length === 0) {
    say("No hay agentes registrados para esta máquina. Ejecutá 'agenthub enroll' primero.")
    return
  }
  for (const item of report.agents) {
    say(`${label(item.agent.cliKind)}  [${item.agent.id}]  ${where(app, item)}`)
    say(`  snapshot: ${describeOutcomeText(item)}`)
    if (item.snapshotHash) say(`  hash:     ${item.snapshotHash.slice(0, 16)}`)
    say(`  ${applied ? 'aplicado' : 'plan'}:  ${describePass(item)}`)
    const allDrift = [...item.drift, ...(item.applied ? item.applied.drift : [])]
    for (const d of allDrift) warn(`  deriva:   ${d.path} [${d.region}]: ${d.reason}`)
    say()
  }
}

function describeOutcomeText(item: AgentPass): string {
  switch (item.outcome.source) {
    case 'control_plane':
      return 'snapshot nuevo del control plane'
    case 'not_modified':
      return 'sin cambios (304)'
    case 'disk':
      return `modo degradado: snapshot en disco (${item.outcome.error})`
    default:
      return `sin snapshot (${item.outcome.error})`
  }
}

async function prompt(question: string, silent = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  if (silent) {
    // Oculta la entrada de la contraseña.
    const output = rl as unknown as { output?: NodeJS.WriteStream; _writeToOutput?: (s: string) => void }
    output._writeToOutput = (s: string): void => {
      if (s.includes(question)) output.output?.write(s)
    }
  }
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      if (silent) process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function cmdEnroll(app: DaemonApp, args: ParsedArgs): Promise<number> {
  let result
  if (args.token) {
    result = args.hostname ? await app.enrollWithToken(args.token, args.hostname) : await app.enrollWithToken(args.token)
  } else {
    if (!args.email) {
      warn('hace falta --token, o --email para enrolar la máquina')
      return EXIT_ERROR
    }
    let password = args.password || process.env['AGENTHUBD_PASSWORD'] || ''
    if (!password) password = await prompt(`Contraseña de ${args.email}: `, true)
    if (!password) {
      warn('hace falta una contraseña para enrolar la máquina')
      return EXIT_ERROR
    }
    result = await app.enroll({ email: args.email, password, ...(args.hostname ? { hostname: args.hostname } : {}) })
  }
  say(`Máquina enrolada: ${result.hostname} (${result.machineId})`)
  say(`Usuario:          ${result.userEmail}`)
  say(`Control plane:    ${app.config.controlPlaneUrl}`)
  say(`Token del daemon: guardado en ${result.credentialsPath} con permisos 0600`)
  say()
  say('CLIs detectados en esta máquina:')
  for (const item of result.detected.found) say(`  sí  ${label(item.cliKind).padEnd(12)} ${item.configPath}`)
  for (const kind of result.detected.missing) say(`  no  ${label(kind).padEnd(12)} sin configuración en ${app.home}`)
  say()
  if (result.registerError) {
    warn(`la máquina quedó enrolada, pero no se pudieron registrar los agentes: ${result.registerError}`)
    return EXIT_ERROR
  }
  if (result.registered.length > 0) {
    say('Agentes registrados en el control plane:')
    for (const agent of result.registered) {
      say(`  ${label(agent.cliKind).padEnd(12)} ${agent.id}  (${agent.enabled ? 'habilitado' : 'apagado en la consola'})`)
    }
  }
  return EXIT_OK
}

async function cmdSync(app: DaemonApp): Promise<number> {
  const report = await app.syncOnce({ apply: true, wait: 0 })
  printSync(app, report, true)
  return report.bootstrapError && report.agents.length === 0 ? EXIT_ERROR : EXIT_OK
}

async function cmdPlan(app: DaemonApp): Promise<number> {
  const report = await app.syncOnce({ apply: false, wait: 0 })
  if (report.bootstrapError) {
    warn(`modo degradado: el control plane no contesta (${report.bootstrapError}). El plan usa el snapshot en disco.`)
  }
  if (report.agents.length === 0) {
    say("No hay agentes registrados para esta máquina. Ejecutá 'agenthub enroll' primero.")
    return EXIT_OK
  }
  let total = 0
  for (const item of report.agents) {
    say(`${label(item.agent.cliKind)}  [${item.agent.id}]  ${where(app, item)}`)
    if (item.skipped) {
      say(`  ${item.skipped}`)
      say()
      continue
    }
    if (item.changes.length === 0) say('  sin cambios: la configuración ya coincide con el snapshot')
    for (const change of item.changes) {
      total += 1
      say(`  ${change.summary || change.path}`)
      for (const line of diffFor(change).split('\n')) say(`    ${line}`)
    }
    for (const d of item.drift) warn(`  deriva: ${d.path} [${d.region}]: ${d.reason}`)
    say()
  }
  say(`${total} cambios propuestos. No se escribió nada: para aplicarlos, 'agenthub sync --once'.`)
  return EXIT_OK
}

function cmdStatus(app: DaemonApp): number {
  const state = app.state
  const credentials = state.loadCredentials()
  say(`Estado del daemon    ${state.root}`)
  say(`HOME                 ${app.home}`)
  say(
    'Transporte           ' +
      (app.stdioGateway
        ? 'stdio (cada CLI lanza su puente; no hay ningún puerto abierto)'
        : `http (un listener con token por agente, desde el puerto ${app.config.gatewayBasePort})`),
  )
  say('Ejecución            procesos locales y conexiones Streamable HTTP')
  if (credentials === null) {
    warn('Abrí Agent Hub para preparar el servicio y detectar tus clientes.')
  } else {
    say(`Servicio local       ${credentials.controlPlaneUrl}`)
    say(`Máquina              ${credentials.machineId}`)
    say(`Usuario              ${credentials.userEmail}`)
    say('Token del daemon     presente (0600)')
  }
  say()
  const detected = detectClis(app.home)
  say('CLIs en esta máquina:')
  for (const item of detected.found) say(`  sí  ${label(item.cliKind).padEnd(12)} ${item.configPath}`)
  for (const kind of detected.missing) say(`  no  ${label(kind).padEnd(12)} sin configuración en ${app.home}`)
  say()
  const agents = app.cachedAgents()
  if (agents.length === 0) {
    say("No hay agentes registrados. Ejecutá 'agenthub enroll' o 'agenthub sync --once'.")
    return EXIT_OK
  }
  say('Agentes registrados:')
  for (const agent of agents) {
    const snapshot = state.loadSnapshot(agent.id) ?? {}
    say(`  ${label(agent.cliKind).padEnd(12)} ${agent.id}`)
    say(`      habilitado:  ${agent.enabled ? 'sí' : 'no (apagado en la consola)'}`)
    say(`      gateway:     ${app.gatewayPointer(agent)}`)
    say(`      hash:        ${String(snapshot['snapshot_hash'] ?? '') || '(sin snapshot)'}`)
    const servers = Array.isArray(snapshot['servers']) ? snapshot['servers'].length : 0
    const skills = Array.isArray(snapshot['skills']) ? snapshot['skills'].length : 0
    const denied = Array.isArray(snapshot['denied']) ? snapshot['denied'].length : 0
    say(`      expone:      ${servers} servers, ${skills} skills, ${denied} apagados`)
  }
  return EXIT_OK
}

function cmdWhy(app: DaemonApp, args: ParsedArgs): number {
  if (!args.tool) {
    warn('hace falta el nombre de la herramienta')
    return EXIT_ERROR
  }
  const name = normalizeToolName(args.tool)
  const explanations = app.explainToolLocal(args.tool)
  if (explanations.length === 0) {
    say(
      `Ninguno de los agentes de esta máquina conoce la herramienta '${name}'. Puede que el nombre esté mal ` +
        "escrito, o que el daemon todavía no haya sincronizado: ejecutá 'agenthub sync --once' y volvé a intentar.",
    )
    return EXIT_OK
  }
  for (const [agent, phrase] of explanations) {
    say(`${label(agent.cliKind)}  [${agent.id}]`)
    say(`  ${phrase}`)
    say()
  }
  return EXIT_OK
}

async function cmdRun(app: DaemonApp, args: ParsedArgs): Promise<number> {
  if (app.config.local && app.state.loadCredentials() === null) {
    const bootstrap = process.env.AGENTHUB_DESKTOP_BOOTSTRAP_TOKEN ?? ''
    if (!bootstrap) throw new DaemonError('falta AGENTHUB_DESKTOP_BOOTSTRAP_TOKEN para preparar el hub local')
    await app.enrollLocal(bootstrap)
  }
  // Bucle de sincronización simple. El puente MCP por stdio lo sirve
  // `@agenthub/gateway`; acá el daemon mantiene los snapshots y la configuración al día.
  const stop = { aborted: false }
  const onSignal = (): void => {
    stop.aborted = true
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  if (process.env.AGENTHUB_STDIN_LIFELINE === '1') {
    // La app de escritorio mantiene abierto stdin. Si muere sin poder detenernos
    // (Forzar salida, SIGKILL) el EOF apaga este daemon en vez de dejarlo huérfano.
    process.stdin.resume()
    process.stdin.once('end', onSignal)
    process.stdin.once('close', onSignal)
  }

  const first = await app.syncOnce({ apply: true, wait: 0 })
  printSync(app, first, true)
  if (app.stdioGateway) {
    say('Transporte stdio: este proceso no abre ningún puerto. Cada CLI lanza su propio gateway.')
  }
  say('Listo. Ctrl-C para salir.')

  let cycles = 1
  while (!stop.aborted) {
    if (args.maxCycles && cycles >= args.maxCycles) break
    await app.syncOnce({ apply: true, wait: 0 })
    await new Promise<void>(resolve => setTimeout(resolve, 1000))
    cycles += 1
  }
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  say('Daemon apagado.')
  return EXIT_OK
}

async function cmdGateway(app: DaemonApp, args: ParsedArgs): Promise<number> {
  if (!args.agent) {
    warn('hace falta --agent para el puente')
    return EXIT_ERROR
  }
  const credentials = app.state.loadCredentials()
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (credentials) {
    env.AGENTHUBD_URL = credentials.controlPlaneUrl
    env.AGENTHUB_GATEWAY_TOKEN = credentials.token
  }
  // Las credenciales OAuth que autorizó la consola viven junto al estado del daemon.
  env.AGENTHUB_OAUTH_DIR ??= join(app.config.stateDir, 'oauth')
  await runHeadless(
    ['--agent', args.agent, '--snapshot', app.state.snapshotPath(args.agent)],
    env,
  )
  return EXIT_OK
}

function printHelp(): void {
  say('agenthub — daemon local de Agent Hub')
  say('Comandos: enroll, run, sync, status, plan, why, gateway')
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)
  if (!args.command) {
    printHelp()
    return EXIT_OK
  }

  try {
    const app = buildApp(args)
    if (args.command === 'gateway') return await cmdGateway(app, args)
    switch (args.command) {
      case 'enroll':
        return await cmdEnroll(app, args)
      case 'sync':
        return await cmdSync(app)
      case 'plan':
        return await cmdPlan(app)
      case 'status':
        return cmdStatus(app)
      case 'why':
        return cmdWhy(app, args)
      case 'run':
        return await cmdRun(app, args)
      default:
        printHelp()
        return EXIT_OK
    }
  } catch (exc) {
    if (exc instanceof DaemonError || exc instanceof ControlPlaneError) {
      warn((exc as Error).message)
      return EXIT_ERROR
    }
    throw exc
  }
}

// Entry point cuando se ejecuta directamente.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (exc) => {
      warn(String(exc instanceof Error ? exc.message : exc))
      process.exit(EXIT_ERROR)
    },
  )
}
