#!/usr/bin/env node
import { runHeadless } from './headless.js'

runHeadless(process.argv.slice(2), process.env).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
