import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const vpEntry = fileURLToPath(new URL('../node_modules/vite-plus/bin/vp', import.meta.url))
if (!existsSync(vpEntry)) process.exit(0)
const result = spawnSync(process.execPath, [vpEntry, 'config'], { stdio: 'inherit' })
process.exit(result.status ?? 0)
