import { rmSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['packages/shared', 'packages/core', 'packages/daemon', 'packages/gateway', 'desktop', 'frontend', 'testdata']
for (const root of roots) {
  rmSync(join(root, 'dist'), { recursive: true, force: true })
  rmSync(join(root, 'out'), { recursive: true, force: true })
  rmSync(join(root, 'tsconfig.tsbuildinfo'), { force: true })
}
