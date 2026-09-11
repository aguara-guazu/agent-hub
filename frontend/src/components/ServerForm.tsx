/** Alta y edicion de un MCP server.
 *
 *  Dos formularios en uno: el transporte decide que campos se piden. `stdio` pide
 *  comando, argumentos, variables de entorno y directorio; `http` pide URL y
 *  encabezados. Cambiar el transporte no borra lo cargado del otro lado, pero solo
 *  se envia lo que corresponde al transporte elegido.
 *
 *  Invariante que sostiene este archivo: por el formulario NUNCA pasa una
 *  credencial. `secret_refs` lleva el NOMBRE con el que el broker la resuelve en el
 *  momento de usarla, y todo valor que se parezca a un token se rechaza antes de
 *  llegar al backend, tambien en `env` y en los encabezados.
 */

import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'

import type { McpServer, Transport , ServerAuth } from '../lib/types'
import { Modal } from './Modal'
import { Spinner } from './Spinner'

/* -------------------------------------------------------------------------- */
/* Deteccion de credenciales pegadas por error                                  */
/* -------------------------------------------------------------------------- */

/** Prefijos publicos de credenciales de proveedores conocidos.
 *  No pretende ser exhaustiva: es la primera red, no la ultima. */
const TOKEN_PREFIXES: readonly string[] = [
  'sk-',
  'sk_live_',
  'sk_test_',
  'pk_live_',
  'rk_live_',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'github_pat_',
  'xoxb-',
  'xoxp-',
  'xoxa-',
  'xoxs-',
  'xapp-',
  'AKIA',
  'ASIA',
  'ya29.',
  'AIza',
  'hf_',
  'glpat-',
  'npm_',
  'dop_v1_',
  'shpat_',
  'SG.',
  'sq0atp-',
  'lin_api_',
  'ATATT',
  'ahd_',
]

const VOWELS = new Set('aeiouAEIOU')

/** Entropia de Shannon en bits por caracter. */
function shannonEntropy(value: string): number {
  if (value.length === 0) return 0
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

function vowelRatio(value: string): number {
  const letters = [...value].filter((char) => /[A-Za-z]/.test(char))
  if (letters.length === 0) return 0
  return letters.filter((char) => VOWELS.has(char)).length / letters.length
}

/**
 * Motivo por el que un valor parece una credencial, o `null` si parece un nombre.
 *
 * La heuristica de "tirada al azar" combina tres senales porque ninguna sola
 * alcanza: un nombre largo en camelCase tambien tiene entropia alta, pero conserva
 * la proporcion de vocales del lenguaje natural, y un token no. Esta calibrada para
 * dejar pasar los nombres que se usan de verdad (`GITHUB_TOKEN`,
 * `keychain:agenthub/gateway`, `op://vault/item/field`, un ARN de Secrets Manager)
 * y frenar lo que se pega desde un gestor de contrasenas. Ante la duda frena: el
 * costo de un falso positivo es renombrar la referencia, el de un falso negativo es
 * un secreto escrito en la base.
 */
/** Esquemas de referencia que el daemon sabe resolver. Espeja `SECRET_SCHEMES`
 *  de `packages/core/src/serialize.ts`. */
export const SECRET_SCHEMES = ['env', 'file', 'keychain'] as const

const SECRET_REF = /^[a-z][a-z0-9+.-]*:\/\/.+$/

/** Devuelve el motivo por el que la referencia no sirve, o null si esta bien.
 *
 *  Se valida acá además de en el backend para que el error aparezca mientras la
 *  persona escribe, y no en la primera llamada de un agente. El mensaje nunca
 *  repite el valor: si el valor es el secreto, repetirlo lo copiaría a la pantalla.
 */
export function invalidSecretRef(value: string): string | null {
  const text = value.trim()
  if (!SECRET_REF.test(text)) {
    return 'no es una referencia. Tiene que ser <backend>://<ruta>, por ejemplo keychain://agenthub/mi-token.'
  }
  const scheme = text.slice(0, text.indexOf('://'))
  if (!SECRET_SCHEMES.includes(scheme as (typeof SECRET_SCHEMES)[number])) {
    return `usa el esquema «${scheme}», que el daemon no resuelve. Disponibles: ${SECRET_SCHEMES.join(', ')}.`
  }
  return null
}

export function looksLikeSecret(value: string): string | null {
  const text = value.trim()
  if (text === '') return null

  if (text.includes('-----BEGIN')) return 'contiene una clave privada en formato PEM'
  if (/^eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\./.test(text)) return 'tiene la forma de un JWT'

  for (const prefix of TOKEN_PREFIXES) {
    if (text.startsWith(prefix) && text.length >= prefix.length + 8) {
      return `empieza con «${prefix}», un prefijo de credencial conocido`
    }
  }

  if (/^[A-Fa-f0-9]{32,}$/.test(text)) return 'es una cadena hexadecimal larga'

  const runs = text.match(/[A-Za-z0-9]+/g) ?? []
  for (const run of runs) {
    if (run.length < 24) continue
    const classes =
      Number(/[a-z]/.test(run)) + Number(/[A-Z]/.test(run)) + Number(/[0-9]/.test(run))
    if (classes >= 3 && shannonEntropy(run) >= 3.6 && vowelRatio(run) < 0.26) {
      return 'tiene una tirada larga de caracteres al azar'
    }
  }

  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0)
  if (text.length >= 40 && longestRun >= 12 && !/\s/.test(text) && shannonEntropy(text) >= 4.0) {
    return 'tiene entropia de secreto, no de nombre'
  }

  return null
}

/* -------------------------------------------------------------------------- */
/* Texto multilinea <-> estructuras                                             */
/* -------------------------------------------------------------------------- */

export type PairSeparator = '=' | ':'

export interface ParsedPairs {
  pairs: Record<string, string>
  errors: string[]
}

/** Lee un textarea de `clave=valor` (o `Nombre: valor`), una por linea.
 *  Las lineas vacias y las que empiezan con `#` se ignoran. */
export function parsePairs(text: string, separator: PairSeparator, label: string): ParsedPairs {
  const pairs: Record<string, string> = {}
  const errors: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const index = line.indexOf(separator)
    if (index <= 0) {
      errors.push(`${label}: la línea «${line}» no tiene la forma clave${separator}valor.`)
      continue
    }
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key === '') {
      errors.push(`${label}: hay una línea sin clave.`)
      continue
    }
    pairs[key] = value
  }
  return { pairs, errors }
}

export function formatPairs(pairs: Record<string, string>, separator: PairSeparator): string {
  return Object.entries(pairs)
    .map(([key, value]) => (separator === '=' ? `${key}=${value}` : `${key}: ${value}`))
    .join('\n')
}

/** Un argumento por linea: los espacios son parte del argumento, no separadores. */
export function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/* -------------------------------------------------------------------------- */
/* Formulario                                                                   */
/* -------------------------------------------------------------------------- */

/** Cuerpo de POST/PATCH /catalog/servers. En edicion el slug no viaja: es inmutable. */
export interface ServerFormPayload {
  slug?: string
  display_name: string
  description: string
  transport: Transport
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  url: string
  headers: Record<string, string>
  secret_refs: Record<string, string>
  auth: ServerAuth
  requires_host_access: boolean
  container_image: string
  allow_hosts: string[]
  allow_ports: number[]
  read_mounts: string[]
  write_mounts: string[]
}

export interface ServerFormProps {
  open: boolean
  /** `null` es alta. Con un server, el slug queda bloqueado. */
  server: McpServer | null
  busy?: boolean
  onSubmit: (payload: ServerFormPayload) => void
  onClose: () => void
}

const SLUG_RE = /^[a-z][a-z0-9_-]{1,47}$/

interface FormState {
  slug: string
  displayName: string
  description: string
  transport: Transport
  command: string
  args: string
  env: string
  cwd: string
  url: string
  headers: string
  secretRefs: string
  auth: ServerAuth
  requiresHostAccess: boolean
  containerImage: string
  allowHosts: string
  allowPorts: string
  readMounts: string
  writeMounts: string
}

function initialState(server: McpServer | null): FormState {
  return {
    slug: server?.slug ?? '',
    displayName: server?.display_name ?? '',
    description: server?.description ?? '',
    transport: server?.transport ?? 'stdio',
    command: server?.command ?? '',
    args: (server?.args ?? []).join('\n'),
    env: formatPairs(server?.env ?? {}, '='),
    cwd: server?.cwd ?? '',
    url: server?.url ?? '',
    headers: formatPairs(server?.headers ?? {}, ':'),
    secretRefs: formatPairs(server?.secret_refs ?? {}, '='),
    auth: server?.auth ?? 'none',
    requiresHostAccess: server?.requires_host_access ?? true,
    containerImage: server?.container_image ?? '',
    allowHosts: (server?.allow_hosts ?? []).join('\n'),
    allowPorts: (server?.allow_ports ?? []).join('\n'),
    readMounts: (server?.read_mounts ?? []).join('\n'),
    writeMounts: (server?.write_mounts ?? []).join('\n'),
  }
}

export function ServerForm({ open, server, busy = false, onSubmit, onClose }: ServerFormProps) {
  const [state, setState] = useState<FormState>(() => initialState(server))
  const [errors, setErrors] = useState<string[]>([])

  // El modal no se desmonta entre aperturas: hay que rehidratar al cambiar de server.
  const serverId = server?.id ?? ''
  useEffect(() => {
    if (open) {
      setState(initialState(server))
      setErrors([])
    }
    // La dependencia es el id y no el objeto: `server` cambia de identidad en cada
    // refetch aunque sea el mismo registro, y eso pisaria lo que la persona escribio.
  }, [open, serverId, server])

  const isEdit = server !== null
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setState((current) => ({ ...current, [key]: value }))

  const secretPreview = useMemo(() => parsePairs(state.secretRefs, '=', 'secret_refs'), [state.secretRefs])

  function validate(): { payload: ServerFormPayload | null; problems: string[] } {
    const problems: string[] = []

    if (!isEdit && !SLUG_RE.test(state.slug.trim())) {
      problems.push('El slug admite minúsculas, dígitos, guion y guion bajo, empieza con letra y tiene entre 2 y 48 caracteres.')
    }
    if (state.displayName.trim() === '') problems.push('El nombre visible es obligatorio.')

    const args = parseLines(state.args)
    const env = parsePairs(state.env, '=', 'env')
    const headers = parsePairs(state.headers, ':', 'encabezados')
    const secretRefs = parsePairs(state.secretRefs, '=', 'secret_refs')
    problems.push(...env.errors, ...headers.errors, ...secretRefs.errors)

    if (state.transport === 'stdio' && state.command.trim() === '') {
      problems.push('Un server stdio necesita un comando.')
    }
    if (state.transport === 'http' && state.url.trim() === '') {
      problems.push('Un server http necesita una URL.')
    }

    // Ningun valor de estos tres campos puede ser una credencial.
    for (const [key, value] of Object.entries(secretRefs.pairs)) {
      const reason = looksLikeSecret(value)
      if (reason !== null) {
        problems.push(
          `secret_refs «${key}»: el valor ${reason}. Aquí va el NOMBRE del secreto en el gestor, nunca su valor.`,
        )
        continue
      }
      const badRef = invalidSecretRef(value)
      if (badRef !== null) problems.push(`secret_refs «${key}»: ${badRef}`)
    }
    if (state.transport === 'stdio') {
      for (const [key, value] of Object.entries(env.pairs)) {
        const reason = looksLikeSecret(value)
        if (reason !== null) {
          problems.push(
            `env «${key}»: el valor ${reason}. Va en secret_refs, por nombre; el broker lo resuelve al conectar.`,
          )
        }
      }
    }
    if (state.transport === 'http') {
      for (const [key, value] of Object.entries(headers.pairs)) {
        const reason = looksLikeSecret(value)
        if (reason !== null) {
          problems.push(
            `Encabezado «${key}»: el valor ${reason}. Va en secret_refs, por nombre; el broker lo resuelve al conectar.`,
          )
        }
      }
    }

    if (problems.length > 0) return { payload: null, problems }

    const stdio = state.transport === 'stdio'
    const payload: ServerFormPayload = {
      display_name: state.displayName.trim(),
      description: state.description.trim(),
      transport: state.transport,
      command: stdio ? state.command.trim() : '',
      args: stdio ? args : [],
      env: stdio ? env.pairs : {},
      cwd: stdio ? state.cwd.trim() : '',
      url: stdio ? '' : state.url.trim(),
      headers: stdio ? {} : headers.pairs,
      secret_refs: secretRefs.pairs,
      auth: stdio ? 'none' : state.auth,
      requires_host_access: stdio ? state.requiresHostAccess : false,
      container_image: stdio ? state.containerImage.trim() : '',
      allow_hosts: parseLines(state.allowHosts),
      allow_ports: parseLines(state.allowPorts)
        .map((p) => Number.parseInt(p, 10))
        .filter((p) => Number.isFinite(p)),
      read_mounts: stdio ? parseLines(state.readMounts) : [],
      write_mounts: stdio ? parseLines(state.writeMounts) : [],
    }
    if (!isEdit) payload.slug = state.slug.trim()
    return { payload, problems: [] }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const { payload, problems } = validate()
    setErrors(problems)
    if (payload !== null) onSubmit(payload)
  }

  return (
    <Modal
      open={open}
      title={isEdit ? `Editar ${server.slug}` : 'Nuevo MCP server'}
      onClose={onClose}
      busy={busy}
      width={640}
    >
      <form id="server-form" className="form-grid" onSubmit={handleSubmit} noValidate>
        {errors.length > 0 && (
          <div className="form-errors" role="alert">
            <strong>No se guardó nada:</strong>
            <ul>
              {errors.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="field-row">
          <div className="field">
            <label htmlFor="server-slug">Identificador</label>
            <input
              id="server-slug"
              value={state.slug}
              disabled={isEdit}
              placeholder="github"
              onChange={(event) => set('slug', event.target.value)}
            />
            <span className="field-hint">{isEdit ? 'El slug no se puede cambiar.' : 'Nombre corto, por ejemplo: excalidraw.'}</span>
          </div>
          <div className="field grow">
            <label htmlFor="server-name">Nombre visible</label>
            <input
              id="server-name"
              value={state.displayName}
              onChange={(event) => set('displayName', event.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="server-description">Descripción</label>
          <input
            id="server-description"
            value={state.description}
            onChange={(event) => set('description', event.target.value)}
          />
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="server-transport">Transporte</label>
            <select
              id="server-transport"
              value={state.transport}
              onChange={(event) => set('transport', event.target.value as Transport)}
            >
              <option value="stdio">stdio (proceso local)</option>
              <option value="http">http (Streamable HTTP)</option>
            </select>
          </div>
        </div>

        {state.transport === 'stdio' ? (
          <fieldset className="form-section">
            <legend>Proceso local</legend>
            <div className="field">
              <label htmlFor="server-command">Comando</label>
              <input
                id="server-command"
                value={state.command}
                placeholder="npx"
                onChange={(event) => set('command', event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="server-args">Argumentos (uno por línea)</label>
              <textarea
                id="server-args"
                rows={3}
                value={state.args}
                placeholder={'-y\n@modelcontextprotocol/server-github'}
                onChange={(event) => set('args', event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="server-env">Variables de entorno (CLAVE=valor)</label>
              <textarea
                id="server-env"
                rows={3}
                value={state.env}
                onChange={(event) => set('env', event.target.value)}
              />
              <span className="field-hint">Solo valores no sensibles. Las credenciales van en secret_refs.</span>
            </div>
            <div className="field">
              <label htmlFor="server-cwd">Directorio de trabajo</label>
              <input id="server-cwd" value={state.cwd} onChange={(event) => set('cwd', event.target.value)} />
            </div>
          </fieldset>
        ) : (
          <fieldset className="form-section">
            <legend>Conexión HTTP</legend>
            <div className="field">
              <label htmlFor="server-url">URL</label>
              <input
                id="server-url"
                value={state.url}
                placeholder="http://localhost:3580/mcp"
                onChange={(event) => set('url', event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="server-headers">Encabezados (Nombre: valor)</label>
              <textarea
                id="server-headers"
                rows={3}
                value={state.headers}
                placeholder={'X-Client: agenthub'}
                onChange={(event) => set('headers', event.target.value)}
              />
              <span className="field-hint">Solo valores no sensibles. Las credenciales van en secret_refs.</span>
            </div>
            <div className="field">
              <label htmlFor="server-auth">Autenticación</label>
              <select
                id="server-auth"
                value={state.auth}
                onChange={(event) => set('auth', event.target.value as ServerAuth)}
              >
                <option value="none">Ninguna o por encabezados</option>
                <option value="oauth">OAuth: iniciar sesión en el navegador</option>
              </select>
              {state.auth === 'oauth' && (
                <span className="field-hint">
                  Al guardar, usá «Conectar cuenta» en la tarjeta. Los tokens quedan en un archivo privado de esta computadora, nunca en la base.
                </span>
              )}
            </div>
          </fieldset>
        )}

        <details className="form-section secrets-section"><summary>Credenciales locales (opcional)</summary>
          <p className="field-hint">Conectá una variable de entorno, un archivo privado o una entrada del llavero. El hub lee su valor en esta computadora al conectar el servidor.</p>
          <p className="field-hint">
            Formato: <code>&lt;backend&gt;://&lt;ruta&gt;</code>. Backends disponibles:{' '}
            {SECRET_SCHEMES.map((scheme) => (
              <code key={scheme}>{scheme}</code>
            )).reduce<ReactNode[]>((acc, el, i) => (i === 0 ? [el] : [...acc, ', ', el]), [])}.
          </p>
          <div className="field">
            <label htmlFor="server-secret-refs">secret_refs (CLAVE=nombre-del-secreto)</label>
            <textarea
              id="server-secret-refs"
              rows={3}
              value={state.secretRefs}
              placeholder={'GITHUB_TOKEN=keychain://agenthub/github\nAPI_KEY=env://AGENTHUB_API_KEY'}
              onChange={(event) => set('secretRefs', event.target.value)}
            />
          </div>
          {Object.keys(secretPreview.pairs).length > 0 && (
            <ul className="secret-preview">
              {Object.entries(secretPreview.pairs).map(([key, value]) => (
                <li key={key}>
                  <code>{key}</code> <span className="muted">→ nombre</span> <code>{value}</code>
                </li>
              ))}
            </ul>
          )}
        </details>

        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <Spinner size={12} label="Guardando" />}
            {isEdit ? 'Guardar cambios' : 'Crear server'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export default ServerForm
