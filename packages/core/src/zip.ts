/**
 * Archivo ZIP mínimo para exportar una skill tal como la espera «Subir skill» de claude.ai:
 * una carpeta `<slug>/` con `SKILL.md` y sus archivos auxiliares.
 *
 * Sólo escribe: entradas deflate (método 8) con nombres UTF-8, directorio central y fin de
 * directorio. No hay ZIP64: una skill nunca se acerca a los 4 GB ni a las 65 535 entradas,
 * y `collectFiles` corta antes por tamaño. Formato según APPNOTE.TXT de PKWARE.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { deflateRawSync } from 'node:zlib'

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
