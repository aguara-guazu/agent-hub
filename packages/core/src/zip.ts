/**
 * Archivo ZIP mínimo para exportar una skill tal como la espera «Subir skill» de claude.ai:
 * una carpeta `<slug>/` con `SKILL.md` y sus archivos auxiliares.
 *
 * Escribe entradas deflate (método 8) con nombres UTF-8, directorio central y fin de
 * directorio. Lee lo mismo más entradas sin comprimir (método 0), para importar skills.
 * No hay ZIP64: una skill nunca se acerca a los 4 GB ni a las 65 535 entradas,
 * y `collectFiles` corta antes por tamaño. Formato según APPNOTE.TXT de PKWARE.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { deflateRawSync, inflateRawSync } from "node:zlib"

export interface ZipEntry {
  /** Ruta dentro del archivo, con `/` como separador. */
  name: string
  data: Buffer
}

/** Tope del contenido total de una skill exportada. */
export const MAX_SKILL_BYTES = 50 * 1024 * 1024

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Fecha y hora en el formato de MS-DOS que usa ZIP (resolución de 2 segundos, desde 1980). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: dosDate }
}

const FLAG_UTF8 = 0x0800
const METHOD_DEFLATE = 8
const VERSION_NEEDED = 20
const EXTERNAL_ATTR_FILE = (0o100644 << 16) >>> 0

export function buildZip(entries: readonly ZipEntry[], now: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(now)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name.split(sep).join('/'), 'utf-8')
    const compressed = deflateRawSync(entry.data)
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(VERSION_NEEDED, 4)
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(METHOD_DEFLATE, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(VERSION_NEEDED, 4)
    central.writeUInt16LE(VERSION_NEEDED, 6)
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(METHOD_DEFLATE, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(EXTERNAL_ATTR_FILE, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)

    locals.push(local, compressed)
    centrals.push(central)
    offset += local.length + compressed.length
  }

  const centralSize = centrals.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, ...centrals, end])
}

/**
 * Archivos regulares de la carpeta de una skill, con rutas relativas y `/`. Se saltan
 * symlinks y entradas ocultas: una skill de la biblioteca no los necesita y un enlace
 * podría salir de la carpeta. Devuelve `null` si la carpeta no existe o no es legible.
 */
export function collectFiles(root: string, limit = MAX_SKILL_BYTES): ZipEntry[] | null {
  try {
    if (!lstatSync(root).isDirectory()) return null
  } catch {
    return null
  }
  const entries: ZipEntry[] = []
  let total = 0
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.')) continue
      const child = join(dir, name)
      const info = lstatSync(child)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        walk(child)
        continue
      }
      if (!info.isFile()) continue
      total += info.size
      if (total > limit) throw new Error(`la skill supera el tope de ${Math.round(limit / 1024 / 1024)} MB`)
      entries.push({ name: relative(root, child).split(sep).join('/'), data: readFileSync(child) })
    }
  }
  walk(root)
  return entries
}

/** ZIP rechazado por formato, seguridad o límites; `status` es el código HTTP que corresponde. */
export class ZipReadError extends Error {
  constructor(readonly status: 413 | 422, message: string) {
    super(message)
  }
}

export interface ZipListing {
  name: string
  method: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
  directory: boolean
}

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const FLAG_ENCRYPTED = 0x0001
const S_IFMT = 0o170000
const S_IFLNK = 0o120000

/** Ruta portable y relativa: sin `\`, NUL, unidad, raíz ni segmentos `.`/`..`/vacíos. */
function unsafeName(name: string): string | null {
  if (name.includes("\\")) return "usa \\ como separador"
  if (name.includes("\0")) return "contiene NUL"
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return "es absoluta"
  const segments = name.replace(/\/$/, "").split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return "sale de la carpeta o tiene segmentos vacíos"
  return null
}

/**
 * Directorio central de un ZIP en memoria, validado entero antes de leer contenido: sin ZIP64,
 * sin entradas cifradas, sin enlaces simbólicos, con rutas seguras y dentro de los topes de
 * entradas y de tamaño descomprimido declarado.
 */
export function listZip(archive: Buffer, limits: { maxEntries: number; maxTotalBytes: number }): ZipListing[] {
  const minEocd = 22
  if (archive.length < minEocd) throw new ZipReadError(422, "el archivo no es un ZIP")
  let eocd = -1
  for (let at = archive.length - minEocd; at >= Math.max(0, archive.length - minEocd - 0xffff); at -= 1) {
    if (archive.readUInt32LE(at) === SIG_EOCD) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new ZipReadError(422, "el archivo no es un ZIP")
  const disk = archive.readUInt16LE(eocd + 4)
  const centralDisk = archive.readUInt16LE(eocd + 6)
  const diskEntries = archive.readUInt16LE(eocd + 8)
  const count = archive.readUInt16LE(eocd + 10)
  const centralSize = archive.readUInt32LE(eocd + 12)
  const centralOffset = archive.readUInt32LE(eocd + 16)
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new ZipReadError(422, "ZIP64 no está soportado")
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== count) throw new ZipReadError(422, "los ZIP en varias partes no están soportados")
  if (count > limits.maxEntries) throw new ZipReadError(413, `el ZIP tiene más de ${limits.maxEntries} entradas`)
  if (centralOffset + centralSize > eocd) throw new ZipReadError(422, "el directorio central del ZIP está dañado")

  const entries: ZipListing[] = []
  const seen = new Set<string>()
  let total = 0
  let at = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > eocd || archive.readUInt32LE(at) !== SIG_CENTRAL) throw new ZipReadError(422, "el directorio central del ZIP está dañado")
    const flags = archive.readUInt16LE(at + 8)
    const method = archive.readUInt16LE(at + 10)
    const crc = archive.readUInt32LE(at + 16)
    const compressedSize = archive.readUInt32LE(at + 20)
    const size = archive.readUInt32LE(at + 24)
    const nameLength = archive.readUInt16LE(at + 28)
    const extraLength = archive.readUInt16LE(at + 30)
    const commentLength = archive.readUInt16LE(at + 32)
    const externalAttr = archive.readUInt32LE(at + 38)
    const localOffset = archive.readUInt32LE(at + 42)
    const end = at + 46 + nameLength + extraLength + commentLength
    if (end > eocd) throw new ZipReadError(422, "el directorio central del ZIP está dañado")
    let name: string
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(archive.subarray(at + 46, at + 46 + nameLength))
    } catch {
      throw new ZipReadError(422, "el ZIP tiene nombres de archivo que no son UTF-8")
    }
    const unsafe = unsafeName(name)
    if (unsafe !== null) throw new ZipReadError(422, `ruta insegura en el ZIP (${unsafe}): ${JSON.stringify(name.slice(0, 200))}`)
    if (flags & FLAG_ENCRYPTED) throw new ZipReadError(422, `el ZIP tiene entradas cifradas: ${name}`)
    if (((externalAttr >>> 16) & S_IFMT) === S_IFLNK) throw new ZipReadError(422, `el ZIP tiene enlaces simbólicos: ${name}`)
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipReadError(422, "ZIP64 no está soportado")
    if (localOffset >= centralOffset) throw new ZipReadError(422, "el directorio central del ZIP está dañado")
    const key = name.replace(/\/$/, "")
    // Case-insensitive: on macOS and Windows `SKILL.md` and `skill.md` are the same file.
    const folded = key.normalize("NFC").toLowerCase()
    if (seen.has(folded)) throw new ZipReadError(422, `el ZIP repite la ruta ${name} (sin distinguir mayúsculas)`)
    seen.add(folded)
    total += size
    if (total > limits.maxTotalBytes) throw new ZipReadError(413, `el contenido del ZIP supera ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB descomprimido`)
    entries.push({ name: key, method, crc, compressedSize, size, localOffset, directory: name.endsWith("/") })
    at = end
  }
  return entries
}

/** Contenido de una entrada, con tope de salida para que un tamaño declarado falso no infle de más. */
export function readZipEntry(archive: Buffer, entry: ZipListing, maxBytes: number): Buffer {
  if (entry.size > maxBytes) throw new ZipReadError(413, `${entry.name} supera ${Math.round(maxBytes / 1024)} KB`)
  const at = entry.localOffset
  if (at + 30 > archive.length || archive.readUInt32LE(at) !== SIG_LOCAL) throw new ZipReadError(422, `la entrada ${entry.name} del ZIP está dañada`)
  const start = at + 30 + archive.readUInt16LE(at + 26) + archive.readUInt16LE(at + 28)
  if (start + entry.compressedSize > archive.length) throw new ZipReadError(422, `la entrada ${entry.name} del ZIP está truncada`)
  const raw = archive.subarray(start, start + entry.compressedSize)
  let data: Buffer
  if (entry.method === 0) {
    data = Buffer.from(raw)
  } else if (entry.method === METHOD_DEFLATE) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: maxBytes + 1 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw new ZipReadError(413, `${entry.name} supera ${Math.round(maxBytes / 1024)} KB`)
      throw new ZipReadError(422, `no se pudo descomprimir ${entry.name}`)
    }
  } else {
    throw new ZipReadError(422, `${entry.name} usa un método de compresión no soportado (${entry.method})`)
  }
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new ZipReadError(422, `${entry.name} no coincide con su tamaño o CRC`)
  return data
}
