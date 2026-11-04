/**
 * Vigía de rollback (macOS). Corre desde una copia, verificada y con fsync, que se prepara ANTES del intercambio desde el runtime
 * de la versión vigente (`<stateDir>/runtime/versions/<from>/`) y con el ejecutable de esa copia: no depende del bundle instalado
 * que el intercambio reemplaza. La copia incluye `update-transaction.js`, que define el journal (contrato B) y sus primitivas.
 *
 * Reglas: nunca se mata ni se sustituye la app vieja exacta (PID + inicio) mientras siga viva; un journal ausente o corrupto con
 * restos es ambiguo y no se borra nada; la identidad de un proceso es PID + inicio + ejecutable real, no su argv.
 */
import { execFileSync, spawn } from "node:child_process"
import { appendFileSync, copyFileSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, sep } from "node:path"
import {
  acquireSwapBackLock, addToBlacklist, advancePhase, bundleVersion, clearTransactionFiles, fsyncPathSync, hasIncomingRemnants, healthyFile, inspectSides,
  parseHealthyMarker, parseStartedMarker, phaseRank, readJson, readTransaction, readyFile, removeDurable, rollbackReadyFile, rollbackRequestFile, sha256File, startedFile, validateLayout, watchdogDir, writeJsonDurable,
  type Identity, type Sides, type SwapLock, type UpdateTransaction as Transaction,
} from "./update-transaction.js"

export * from "./update-transaction.js"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------------------------------------------------
// Procesos
const PS_LINE = /^\s*(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/

/** Hora de inicio de un proceso tal como la informa `ps`; `null` si ya no existe. Junto con el PID es su identidad. */
export function startTimeOf(pid: number): string | null {
  try { return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null } catch { return null }
}

export function executableOf(pid: number): string | null {
  try { return execFileSync("/bin/ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null } catch { return null }
}

function realOrSelf(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

/** El ejecutable real del proceso está dentro del árbol del bundle; el contenido de argv no cuenta. */
export function executableUnder(executable: string | null, tree: string): boolean {
  if (!executable || !isAbsolute(executable)) return false
  const root = realOrSelf(tree) + sep
  return realOrSelf(executable).startsWith(root)
}

export function sameProcess(id: Identity): boolean { return startTimeOf(id.pid) === id.start }

export function listProcesses(): Array<{ pid: number; start: string; executable: string }> {
  const out = execFileSync("/bin/ps", ["-axo", "pid=,lstart=,comm="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
  const processes: Array<{ pid: number; start: string; executable: string }> = []
  for (const line of out.split("\n")) {
    const match = PS_LINE.exec(line)
    if (match) processes.push({ pid: Number(match[1]), start: match[2]!, executable: match[3]!.trim() })
  }
  return processes
}

// ---------------------------------------------------------------------------------------------------------------------
// ¿Quedó sana la versión nueva?

export type Settled = "healthy" | "pending" | "ambiguous"

/**
 * Salud confirmada solo con un marcador de ESTA transacción y de la versión esperada. Journal ausente o corrupto no es
 * salud: con restos `.incoming-*` o con una transacción esperada es ambiguo.
 */
export function settled(dir: string, expectedId: string): Settled {
  const journal = readTransaction(dir)
  if (journal.kind !== "ok") return "ambiguous"
  const tx = journal.tx
  if (tx.transaction_id !== expectedId) return "ambiguous"
  if (tx.phase === "ambiguous") return "ambiguous"
  if (tx.phase === "rolled_back") return "pending"
  const raw = readJson(healthyFile(dir, expectedId))
  const marker = raw.ok ? parseHealthyMarker(raw.value) : null
  return marker?.transaction_id === expectedId && marker.version === tx.to.version && phaseRank(tx.phase) >= phaseRank("swapped") ? "healthy" : "pending"
}


// ---------------------------------------------------------------------------------------------------------------------
// Preparación del vigía (antes del intercambio)

export interface PrepareWatchdogOptions {
  stateDir: string
  updateDir: string
  transaction: Transaction
  /** Plazo que se le da a la versión nueva para confirmar salud. */
  timeoutMs: number
  logFile: string
  /** Nombre del ejecutable dentro de `Contents/MacOS`. */
  executableName: string
  /** Presupuestos del vigía; por defecto 90 s para el cierre de la app vieja y 90 s para confirmar la restaurada. */
  oldExitMs?: number
  relaunchConfirmMs?: number
  /** Para pruebas. */
  readyTimeoutMs?: number
}

/**
 * Prepara y confirma el vigía desde el runtime anterior: copia el script, verifica que la copia es idéntica y la hace
 * durable, lo lanza con el ejecutable de esa copia y espera tanto el evento `spawn` como su marca de listo. Devuelve su
 * identidad (PID e inicio) para registrarla en la fase `watchdog_ready`; si algo falla lanza y no hay nada que revertir.
 */
export async function prepareWatchdog(options: PrepareWatchdogOptions): Promise<Identity> {
  const { transaction: tx, updateDir } = options
  validateLayout(tx, options.stateDir)
  const sourceDir = join(tx.paths.runtime_old, "Contents", "Resources", "app", "desktop", "dist")
  const executable = join(tx.paths.runtime_old, "Contents", "MacOS", options.executableName)
  if (!statSync(executable).isFile()) throw new Error("el runtime anterior no trae el ejecutable")
  mkdirSync(updateDir, { recursive: true, mode: 0o700 })
  // El vigía y el módulo del journal se copian juntos a un directorio propio de la transacción, con package.json de tipo módulo.
  const copyDir = watchdogDir(updateDir, tx.transaction_id)
  removeDurable(copyDir)
  mkdirSync(copyDir, { recursive: true, mode: 0o700 })
  for (const name of ["update-watchdog.js", "update-transaction.js", "update-contract.js"]) {
    const source = join(sourceDir, name), target = join(copyDir, name)
    if (!statSync(source).isFile()) throw new Error(`el runtime anterior no trae ${name}`)
    copyFileSync(source, target)
    if (sha256File(target) !== sha256File(source)) throw new Error(`la copia de ${name} no coincide con el original`)
    fsyncPathSync(target)
  }
  writeFileSync(join(copyDir, "package.json"), '{"type":"module"}')
  fsyncPathSync(join(copyDir, "package.json"))
  fsyncPathSync(copyDir)
  fsyncPathSync(updateDir)
  const script = join(copyDir, "update-watchdog.js")
  const helperDigest = sha256File(join(tx.paths.runtime_old, "Contents", "Resources", "bin", "agenthub-swap"))
  removeDurable(readyFile(updateDir, tx.transaction_id))
  const args = [script, "--update-dir", updateDir, "--state-dir", options.stateDir, "--tx", tx.transaction_id, "--timeout-ms", String(options.timeoutMs), "--log", options.logFile,
    "--executable-name", options.executableName, "--helper-sha256", helperDigest,
    ...(options.oldExitMs ? ["--old-exit-ms", String(options.oldExitMs)] : []), ...(options.relaunchConfirmMs ? ["--relaunch-confirm-ms", String(options.relaunchConfirmMs)] : [])]
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", AGENTHUB_UPDATE_WATCHDOG: "1" }
  const child = spawn(executable, args, { detached: true, stdio: "ignore", env })
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve())
    child.once("error", reject)
  })
  child.unref()
  const pid = child.pid
  if (!pid) throw new Error("el vigía no tiene PID")
  // El proceso existe, pero solo está listo cuando validó el journal y escribió su marca.
  const deadline = Date.now() + (options.readyTimeoutMs ?? 10_000)
  for (;;) {
    const ready = readJson(readyFile(updateDir, tx.transaction_id))
    const value = ready.ok ? (ready.value as { pid?: unknown; start?: unknown; transaction_id?: unknown }) : null
    if (value && value.pid === pid && value.transaction_id === tx.transaction_id && typeof value.start === "string" && value.start === startTimeOf(pid)) return { pid, start: value.start }
    if (!sameProcessAlive(pid)) throw new Error("el vigía terminó antes de quedar listo")
    if (Date.now() > deadline) { try { process.kill(pid, "SIGTERM") } catch { /* ya terminó */ } throw new Error("el vigía no confirmó que está listo") }
    await sleep(100)
  }
}

function sameProcessAlive(pid: number): boolean { return startTimeOf(pid) !== null }

// ---------------------------------------------------------------------------------------------------------------------
// Vigía

export interface WatchdogArgs { updateDir: string; stateDir: string; tx: string; timeoutMs: number; log: string; executableName: string; helperSha256: string; oldExitMs: number; relaunchConfirmMs: number }

export function parseWatchdogArgs(argv: string[]): WatchdogArgs {
  const value = (name: string): string => {
    const index = argv.indexOf(`--${name}`)
    const found = index >= 0 ? argv[index + 1] : undefined
    if (!found) throw new Error(`falta --${name}`)
    return found
  }
  const optional = (name: string, fallback: number): number => {
    const index = argv.indexOf(`--${name}`)
    const parsed = index >= 0 ? Number.parseInt(argv[index + 1] ?? "", 10) : fallback
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }
  const helperSha256 = value("helper-sha256")
  if (!/^[a-f0-9]{64}$/.test(helperSha256)) throw new Error("helper-sha256 inválido")
  return {
    updateDir: value("update-dir"), stateDir: value("state-dir"), tx: value("tx"), timeoutMs: Number.parseInt(value("timeout-ms"), 10), log: value("log"),
    executableName: value("executable-name"), helperSha256,
    oldExitMs: optional("old-exit-ms", OLD_APP_EXIT_MS), relaunchConfirmMs: optional("relaunch-confirm-ms", RELAUNCH_CONFIRM_MS),
  }
}

export type WatchdogResult = "healthy" | "rolled-back" | "aborted" | "ambiguous" | "failed"

/** La app vieja (misma identidad, no un PID reciclado) tiene este tiempo tras `swap_intent` para terminar; si no, el vigía no hace nada destructivo. */
const OLD_APP_EXIT_MS = 10 * 60_000
/** Sin intercambio en curso, un vigía no vive más que esto. */
const IDLE_LIFETIME_MS = 30 * 60_000
const STOP_GRACE_MS = 25_000
/** Tiempo que se espera a que reaparezca una app nueva registrada que dejó de existir, antes de revertir sin agotar el plazo. */
const NEW_APP_GONE_GRACE_MS = 5_000
/** Holgura entre el inicio del intercambio y la primera vez que el vigía lo ve (sondeo de 0,5 s) más la resolución de 1 s de `ps`. */
const SWAP_START_TOLERANCE_MS = 1_500

async function launchInstalledApp(installed: string, executableName: string, transactionId: string): Promise<Identity> {
  if (!executableName || basename(executableName) !== executableName) throw new Error("nombre de ejecutable inválido")
  const executable = join(installed, "Contents", "MacOS", executableName)
  const info = statSync(executable)
  if (!info.isFile() || !(info.mode & 0o111) || !executableUnder(executable, installed)) throw new Error("el ejecutable de la app nueva no es válido")
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTHUB_UPDATE_TX: transactionId }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.AGENTHUB_UPDATE_WATCHDOG
  const child = spawn(executable, ["--hidden", "--updated"], { detached: true, stdio: "ignore", env })
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
  child.unref()
  if (!child.pid) throw new Error("la app nueva no tiene PID")
  const deadline = Date.now() + 5_000
  let start: string | null = null
  while (!(start = startTimeOf(child.pid)) && Date.now() < deadline) await sleep(50)
  if (!start || startTimeOf(child.pid) !== start || !executableUnder(executableOf(child.pid), installed)) throw new Error("la app nueva no confirmó su identidad")
  return { pid: child.pid, start }
}

export interface ForwardSwapOperations {
  read(): Transaction | null
  isAlive(identity: Identity): boolean
  sides(transaction: Transaction): Sides
  lock(): SwapLock | null
  swap(transaction: Transaction, lock: SwapLock): void
  sync(transaction: Transaction): void
  launch(transaction: Transaction): Promise<Identity>
  advance(phase: "swapped" | "launched", patch?: Partial<Pick<Transaction, "new_app">>): Transaction
}

/** Executes the one forward swap after revalidating every destructive precondition under the durable swap lock. */
export async function performForwardSwap(transaction: Transaction, operations: ForwardSwapOperations): Promise<Transaction> {
  if (transaction.phase !== "swap_intent") throw new Error("la transacción no está lista para intercambiar")
  if (operations.isAlive(transaction.old_app)) throw new Error("la app vieja sigue viva")
  if (operations.sides(transaction) !== "not_swapped") throw new Error("los lados no están listos para el intercambio")
  const lock = operations.lock()
  if (!lock) throw new Error("otro proceso controla el intercambio")
  let swapped: Transaction
  try {
    const current = operations.read()
    if (!current || current.transaction_id !== transaction.transaction_id || current.phase !== "swap_intent") throw new Error("la transacción cambió antes del intercambio")
    if (operations.isAlive(current.old_app)) throw new Error("la app vieja volvió a estar viva")
    if (operations.sides(current) !== "not_swapped") throw new Error("los lados cambiaron antes del intercambio")
    operations.swap(current, lock)
    operations.sync(current)
    if (operations.sides(current) !== "swapped") throw new Error("el helper no dejó las versiones en los lados esperados")
    swapped = operations.advance("swapped")
  } finally {
    lock.release()
  }
  const identity = await operations.launch(swapped)
  if (!Number.isInteger(identity.pid) || identity.pid <= 1 || !identity.start) throw new Error("la app nueva no confirmó su identidad")
  return operations.advance("launched", { new_app: identity })
}

export interface RollbackPreparationOperations {
  request(transaction: Transaction): void
  waitForExit(identity: Identity): Promise<boolean>
  stopUnadmitted(transaction: Transaction): Promise<boolean>
}

/** Never signals a version that admitted work; it requests a convergent drain and waits for its exact identity to exit. */
export async function prepareRollback(transaction: Transaction, operations: RollbackPreparationOperations): Promise<boolean> {
  if (transaction.phase === "admitting" || transaction.phase === "admitted") {
    if (!transaction.new_app) return false
    operations.request(transaction)
    return operations.waitForExit(transaction.new_app)
  }
  return operations.stopUnadmitted(transaction)
}

export async function runWatchdog(args: WatchdogArgs): Promise<WatchdogResult> {
  const log = (line: string): void => {
    try { mkdirSync(dirname(args.log), { recursive: true }); appendFileSync(args.log, `${new Date().toISOString()} [updater] vigía ${args.tx}: ${line}\n`) } catch { /* el registro no debe frenar el rollback */ }
  }
  const ambiguous = (reason: string, mark = true): WatchdogResult => {
    log(`estado ambiguo: ${reason}; no se borró nada ni se declara salud`)
    if (mark) { try { advancePhase(args.updateDir, args.tx, "ambiguous") } catch { /* con el journal ilegible no hay dónde marcarlo */ } }
    return "ambiguous"
  }

  const first = readTransaction(args.updateDir)
  if (first.kind !== "ok" || first.tx.transaction_id !== args.tx) return ambiguous("el journal falta, está corrupto o es de otra transacción", false)
  try { validateLayout(first.tx, args.stateDir) } catch (error) { return ambiguous(`rutas inesperadas (${error instanceof Error ? error.message : String(error)})`) }
  const { installed, incoming, runtime_old: runtimeOld } = first.tx.paths
  const myPid = process.pid, myStart = startTimeOf(myPid)
  if (!myStart) return ambiguous("no se pudo leer la identidad propia", false)
  writeJsonDurable(readyFile(args.updateDir, args.tx), { transaction_id: args.tx, pid: myPid, start: myStart })
  log(`listo (v${first.tx.from.version} → v${first.tx.to.version}); plazo de salud ${Math.round(args.timeoutMs / 1000)} s`)

  // 1. Hasta que haya intercambio, solo se observa. Si el journal se limpia o la transacción se cancela, no hay nada que revertir.
  const startedAt = Date.now()
  let swapSeenAt: number | null = null
  for (;;) {
    const read = readTransaction(args.updateDir)
    if (read.kind === "missing") return hasIncomingRemnants(installed) ? ambiguous("el journal desapareció con restos .incoming-*", false) : (log("la transacción se canceló; no hay nada que revertir"), "aborted")
    if (read.kind === "corrupt" || read.tx.transaction_id !== args.tx) return ambiguous("el journal se corrompió o cambió de transacción", false)
    const tx = read.tx
    if (tx.phase === "ambiguous") return "ambiguous"
    if (tx.phase === "rolled_back") return "rolled-back"
    if (tx.phase === "healthy" || tx.phase === "done") { log("versión nueva confirmada"); return "healthy" }
    if (tx.watchdog && (tx.watchdog.pid !== myPid || tx.watchdog.start !== myStart)) {
      if (["swapped", "launched", "admitting", "admitted"].includes(tx.phase) && !sameProcess(tx.watchdog))
        advancePhase(args.updateDir, args.tx, tx.phase, { watchdog: { pid: myPid, start: myStart } })
      else { log("otro vigía es responsable de esta transacción; este termina"); return "aborted" }
    }
    const oldAlive = sameProcess(tx.old_app)
    if (phaseRank(tx.phase) >= phaseRank("swap_intent")) {
      swapSeenAt ??= Date.now()
      // La app vieja está cerrándose (o ya cerró): el plazo de salud corre desde que terminó.
      if (!oldAlive) break
      // Nunca se intercambia de vuelta, se relanza ni se mata mientras la app vieja exacta siga viva. Si pasa su presupuesto, el vigía
      // no hace nada destructivo: deja la fase en ambiguous y la recuperación del próximo arranque decide con los dos lados a la vista.
      if (Date.now() - swapSeenAt > args.oldExitMs) return ambiguous("la app vieja sigue viva mucho después de swap_intent; no se toca nada")
    } else if (!oldAlive) {
      log(`la app vieja terminó sin intercambiar (fase ${tx.phase}); la recuperación del próximo arranque limpia`)
      return "aborted"
    }
    if (Date.now() - startedAt > IDLE_LIFETIME_MS) { log("sin intercambio tras mucho tiempo; el vigía termina sin tocar nada"); return "aborted" }
    await sleep(500)
  }

  // 2. El vigía es el único dueño del intercambio hacia adelante y del primer arranque de la versión nueva.
  let tx = (readTransaction(args.updateDir) as { kind: "ok"; tx: Transaction }).tx
  let forwardFailure: string | null = null
  const launch = (current: Transaction) => launchInstalledApp(current.paths.installed, args.executableName, current.transaction_id)
  if (tx.phase === "swap_intent") {
    let sides = inspectSides(tx)
    for (let attempt = 0; attempt < 6 && sides === "unknown"; attempt++) { await sleep(500); sides = inspectSides(tx) }
    if (sides === "unknown") return ambiguous("las versiones de las dos rutas no permiten saber cómo quedó el intercambio")
    if (sides === "swapped") tx = advancePhase(args.updateDir, args.tx, "swapped")
    else try {
      tx = await performForwardSwap(tx, {
        read: () => { const current = readTransaction(args.updateDir); return current.kind === "ok" ? current.tx : null },
        isAlive: sameProcess,
        sides: inspectSides,
        lock: () => acquireSwapBackLock(args.updateDir, { pid: myPid, start: myStart }, sameProcess),
        swap: (current, lock) => {
          const candidate = join(current.paths.runtime_old, "Contents", "Resources", "bin", "agenthub-swap")
          const info = statSync(candidate)
          if (!info.isFile() || !(info.mode & 0o111) || sha256File(candidate) !== args.helperSha256) throw new Error("el agenthub-swap ya no coincide con el verificado")
          execFileSync(candidate, [current.paths.installed, current.paths.incoming], {
            stdio: ["ignore", "ignore", "ignore", lock.fd],
            env: { ...process.env, AGENTHUB_SWAP_LOCK_FD: "3", AGENTHUB_SWAP_LOCK_PATH: lock.path },
          })
        },
        sync: current => fsyncPathSync(dirname(current.paths.installed)),
        launch,
        advance: (phase, patch) => advancePhase(args.updateDir, args.tx, phase, patch),
      })
    } catch (error) {
      forwardFailure = error instanceof Error ? error.message : String(error)
      const latest = readTransaction(args.updateDir)
      if (latest.kind !== "ok" || latest.tx.transaction_id !== args.tx) return ambiguous(`falló el intercambio hacia adelante (${forwardFailure})`, false)
      tx = latest.tx
      if (tx.phase === "swap_intent" && inspectSides(tx) === "swapped") tx = advancePhase(args.updateDir, args.tx, "swapped")
      else if (tx.phase === "swap_intent") return ambiguous(`falló el intercambio hacia adelante (${forwardFailure})`)
    }
  }
  if (tx.phase === "swapped" && !forwardFailure) {
    try {
      const identity = await launch(tx)
      tx = advancePhase(args.updateDir, args.tx, "launched", { new_app: identity })
    } catch (error) {
      forwardFailure = error instanceof Error ? error.message : String(error)
    }
  }

  // 3. Espera de salud con marcador de esta transacción. El plazo corre desde que la app vieja terminó.
  const deadline = Date.now() + (forwardFailure ? 0 : args.timeoutMs)
  let newAppGoneAt: number | null = null
  let reason = forwardFailure ? `no pudo iniciar (${forwardFailure})` : "no confirmó salud a tiempo"
  while (Date.now() < deadline) {
    const state = settled(args.updateDir, args.tx)
    if (state === "healthy") { log("versión nueva confirmada"); return "healthy" }
    if (state === "ambiguous") return ambiguous("el journal dejó de ser válido durante la espera", false)
    const current = readTransaction(args.updateDir)
    if (current.kind === "ok" && (current.tx.phase === "rolled_back")) return "rolled-back"
    // Una app nueva que se registró y terminó sin confirmar salud (no arrancó o se cayó) no necesita agotar todo el plazo: mientras
    // core esté caído los agentes no tienen MCP, así que se revierte en cuanto pasa una breve gracia sin que reaparezca.
    if (current.kind === "ok" && current.tx.new_app && !sameProcess(current.tx.new_app)) {
      newAppGoneAt ??= Date.now()
      if (Date.now() - newAppGoneAt > NEW_APP_GONE_GRACE_MS) { reason = "terminó sin confirmar salud"; break }
    } else newAppGoneAt = null
    await sleep(1000)
  }
  if (settled(args.updateDir, args.tx) === "healthy") return "healthy"

  // 4. Rollback. Solo con el journal válido, en swapped/launched y con las dos versiones exactamente donde se espera.
  log(`v${tx.to.version} ${reason}; se restaura v${tx.from.version}`)
  const latest = readTransaction(args.updateDir)
  if (latest.kind !== "ok" || latest.tx.transaction_id !== args.tx) return ambiguous("el journal no es utilizable para el rollback", false)
  tx = latest.tx
  if (tx.phase !== "swapped" && tx.phase !== "launched" && tx.phase !== "admitting" && tx.phase !== "admitted") return ambiguous(`fase ${tx.phase} inesperada para un rollback`)
  if (inspectSides(tx) !== "swapped") return ambiguous("las versiones instalada y de respaldo no son las esperadas")
  const helper = join(runtimeOld, "Contents", "Resources", "bin", "agenthub-swap")
  try { if (!(statSync(helper).mode & 0o111) || sha256File(helper) !== args.helperSha256) throw new Error("no coincide") } catch { return ambiguous("el agenthub-swap ya no coincide con el verificado") }

  // La app vieja exacta debe haber terminado: con ella viva no se intercambia ni se relanza (retiene el candado de instancia única y el puerto).
  if (sameProcess(tx.old_app)) return ambiguous("la app vieja volvió a estar viva antes del rollback; no se toca nada")
  const lock = acquireSwapBackLock(args.updateDir, { pid: myPid, start: myStart }, sameProcess)
  if (!lock) return ambiguous("otro proceso está deshaciendo el intercambio", false)
  let released = false
  const unlock = (): void => { if (!released) { released = true; lock.release() } }
  try {
    // 4a. Before admission the exact new app may be stopped. After admission, request its convergent drain and only observe exit.
    const prepared = await prepareRollback(tx, {
      request: current => writeJsonDurable(rollbackRequestFile(args.updateDir, current.transaction_id), {
        transaction_id: current.transaction_id,
        version: current.to.version,
        requested_at: new Date().toISOString(),
      }),
      waitForExit: async identity => {
        const deadline = Date.now() + args.oldExitMs
        while (sameProcess(identity) && Date.now() < deadline) await sleep(500)
        if (sameProcess(identity)) return false
        const ready = readJson(rollbackReadyFile(args.updateDir, tx.transaction_id))
        const value = ready.ok ? ready.value as {
          transaction_id?: unknown; version?: unknown; app?: { pid?: unknown; start?: unknown }; core?: { pid?: unknown; start?: unknown }
        } : null
        const appMatches = value?.transaction_id === tx.transaction_id && value.version === tx.to.version
          && value.app?.pid === identity.pid && value.app.start === identity.start
        const corePid = value?.core?.pid, coreStart = value?.core?.start
        return Boolean(appMatches && Number.isInteger(corePid) && typeof coreStart === "string" && startTimeOf(corePid as number) !== coreStart)
      },
      stopUnadmitted: current => stopNewApp(current, installed, (swapSeenAt ?? startedAt) - SWAP_START_TOLERANCE_MS, log),
    })
    if (!prepared) return ambiguous(["admitting", "admitted"].includes(tx.phase) ? "la app nueva no completó el drenaje para rollback" : "no se pudo detener con certeza la app nueva")
    const beforeSwap = readTransaction(args.updateDir)
    if (beforeSwap.kind !== "ok" || beforeSwap.tx.transaction_id !== args.tx || !["swapped", "launched", "admitting", "admitted"].includes(beforeSwap.tx.phase))
      return ambiguous("la transacción cambió antes del rollback", false)
    tx = beforeSwap.tx
    if (sameProcess(tx.old_app) || (tx.new_app && sameProcess(tx.new_app))) return ambiguous("una app registrada sigue viva antes del rollback")
    if (inspectSides(tx) !== "swapped") return ambiguous("los lados cambiaron antes del rollback")
    if (sha256File(helper) !== args.helperSha256) return ambiguous("el agenthub-swap cambió antes del rollback")
    // 4b. Intercambio atómico de vuelta con el helper de la versión anterior; después se verifica y se hace durable.
    execFileSync(helper, [installed, incoming], {
      stdio: ["ignore", "ignore", "ignore", lock.fd],
      env: { ...process.env, AGENTHUB_SWAP_LOCK_FD: "3", AGENTHUB_SWAP_LOCK_PATH: lock.path },
    })
    fsyncPathSync(dirname(installed))
    if (bundleVersion(installed) !== tx.from.version || bundleVersion(incoming) !== tx.to.version) return ambiguous("tras el intercambio las versiones no son las esperadas")
    // 4c. Lista negra con versión y digest, sin reconstruir el estado sensible; después el journal.
    const where = addToBlacklist(args.updateDir, { version: tx.to.version, digest: tx.to.digest }, tx.transaction_id)
    if (where === "sidecar") log("state.json no se pudo leer con certeza; la lista negra quedó en un archivo aparte y el estado intacto")
    unlock()
    // 4d. Reabrir la versión anterior UNA vez. Cuenta como éxito cuando ella misma escribe su marcador `started-<id>` con su PID dentro
    // del plazo; sin eso la transacción queda ambigua, sin reintentos en bucle y conservando toda la evidencia.
    if (await relaunchAndAwaitMarker(installed, args.executableName, args.updateDir, tx, args.relaunchConfirmMs, log)) {
      log(`v${tx.to.version} añadida a la lista negra; v${tx.from.version} reabierta y en marcha`)
      clearTransactionFiles(args.updateDir, args.tx)
      return "rolled-back"
    }
    return ambiguous(`v${tx.from.version} no confirmó que quedó en marcha tras reabrirla (sin started-${args.tx}.json); se conserva la evidencia`)
  } catch (error) {
    log(`no se pudo restaurar la versión anterior: ${error instanceof Error ? error.message : String(error)}; no se borró nada`)
    return "failed"
  } finally {
    unlock()
  }
}

/** Detiene la app nueva sin tocar procesos ajenos. `false` si quedó algo que no se pudo confirmar. */
async function stopNewApp(tx: Transaction, installed: string, notBefore: number, log: (line: string) => void): Promise<boolean> {
  const victims = new Map<number, string>()
  if (tx.new_app && sameProcess(tx.new_app) && executableUnder(executableOf(tx.new_app.pid), installed)) victims.set(tx.new_app.pid, tx.new_app.start)
  // La app puede haber arrancado sin alcanzar a registrarse: se buscan procesos cuyo ejecutable real está en el bundle instalado
  // y que empezaron después de iniciarse el intercambio; los anteriores pertenecen a la versión vieja y no se tocan.
  for (const proc of listProcesses()) {
    if (executableUnder(proc.executable, installed) && Date.parse(proc.start) >= notBefore) victims.set(proc.pid, proc.start)
  }
  victims.delete(process.pid)
  if (victims.size === 0) return true
  log(`se detienen ${victims.size} proceso(s) de la versión nueva`)
  const stillThere = (): Array<[number, string]> => [...victims].filter(([pid, start]) => startTimeOf(pid) === start)
  for (const [pid] of stillThere()) { try { process.kill(pid, "SIGTERM") } catch { /* terminó */ } }
  const graceEnd = Date.now() + STOP_GRACE_MS
  while (stillThere().length > 0 && Date.now() < graceEnd) await sleep(500)
  for (const [pid, start] of stillThere()) {
    // Se vuelve a comprobar la identidad justo antes de forzar: el PID pudo reciclarse durante la espera.
    if (startTimeOf(pid) === start) { try { process.kill(pid, "SIGKILL") } catch { /* terminó */ } }
  }
  await sleep(500)
  return stillThere().length === 0
}

/** Plazo por defecto para que la app restaurada escriba su marcador de arranque. */
const RELAUNCH_CONFIRM_MS = 60_000

/**
 * Abre la app restaurada y espera que ELLA escriba `started-<id>.json` con su PID (el mismo que se lanzó), su inicio exacto y la
 * versión anterior. Que el proceso haya nacido (evento `spawn`) no basta: puede salir enseguida por el candado de instancia única.
 * No se reintenta: si el proceso muere o vence el plazo, devuelve `false`.
 */
async function relaunchAndAwaitMarker(installed: string, executableName: string, updateDir: string, tx: Transaction, confirmMs: number, log: (line: string) => void): Promise<boolean> {
  let identity: Identity
  try { identity = await launchInstalledApp(installed, executableName, tx.transaction_id) } catch { return false }
  const { pid, start } = identity
  const deadline = Date.now() + confirmMs
  while (Date.now() < deadline) {
    const raw = readJson(startedFile(updateDir, tx.transaction_id))
    const marker = raw.ok ? parseStartedMarker(raw.value) : null
    if (marker && marker.transaction_id === tx.transaction_id && marker.version === tx.from.version && marker.pid === pid && start !== null && marker.start === start && startTimeOf(pid) === start) return true
    if (start === null || startTimeOf(pid) !== start) { log("la app restaurada terminó antes de escribir su marcador"); return false }
    await sleep(500)
  }
  return false
}

if (process.env.AGENTHUB_UPDATE_WATCHDOG === "1") {
  void runWatchdog(parseWatchdogArgs(process.argv.slice(2))).then(() => process.exit(0), () => process.exit(1))
}
