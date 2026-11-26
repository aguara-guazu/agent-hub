import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { check } from '../contracts.js'

const run = promisify(execFile)
async function binary(name: string) {
  const paths = isAbsolute(name)
    ? [name]
    : (process.env.PATH || '')
        .split(delimiter)
        .filter(isAbsolute)
        .map((p) => join(p, name))
  for (const path of paths) {
    try {
      await access(path, constants.X_OK)
      return await realpath(path)
    } catch {
      /* Try the next executable directory. */
    }
  }
  throw new Error('No se encontró el ejecutable de verificación ' + name)
}

/** Verification executes project code. Only the worktree and a fresh temporary directory are writable. */
export async function verifyWorktree(argv: string[], dir: string, signal: AbortSignal) {
  const executable = await binary(argv[0]!),
    temp = await realpath(await mkdtemp(join(tmpdir(), 'hub-verify-')))
  try {
    const env = {
      PATH: [dirname(executable), dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(delimiter),
      HOME: temp,
      TMPDIR: temp,
      CI: '1',
    }
    const options = { cwd: dir, signal, timeout: 180_000, maxBuffer: 1_000_000, env }
    if (process.platform === 'darwin') {
      const read = [
        '/System',
        '/usr',
        '/bin',
        '/sbin',
        '/Library',
        '/opt/homebrew',
        '/private/etc',
        '/dev',
        dirname(process.execPath),
        dirname(executable),
        dir,
        temp,
      ]
      const paths = (entries: string[]) => entries.map((p) => '(subpath ' + JSON.stringify(p) + ')').join(' ')
      const policy =
        '(version 1) (deny default) (import "system.sb") (deny network*) (allow process*) (allow sysctl-read) (allow file-read-metadata) ' +
        '(allow file-read* ' +
        paths(read) +
        ') (allow file-write* ' +
        paths([dir, temp]) +
        ' (literal "/dev/null"))'
      await run('/usr/bin/sandbox-exec', ['-p', policy, executable, ...argv.slice(1)], options)
    } else {
      check(process.platform === 'linux', 'Las verificaciones personalizadas requieren un entorno de ejecución aislado', 409)
      const roots = ['/usr', '/bin', '/sbin', '/lib', '/lib64', dirname(process.execPath), dirname(executable)]
      const mounts: string[] = []
      for (const path of new Set(roots)) {
        try {
          await access(path)
          mounts.push('--ro-bind', path, path)
        } catch {
          /* This system path is optional. */
        }
      }
      await run(
        await binary('bwrap'),
        [
          '--die-with-parent',
          '--unshare-all',
          ...mounts,
          '--dev',
          '/dev',
          '--proc',
          '/proc',
          '--tmpfs',
          '/tmp',
          '--bind',
          dir,
          dir,
          '--bind',
          temp,
          temp,
          '--chdir',
          dir,
          '--',
          executable,
          ...argv.slice(1),
        ],
        options,
      )
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
