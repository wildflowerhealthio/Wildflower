import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * True when the module at `moduleUrl` (its `import.meta.url`) is the process
 * entrypoint (`node scripts/<script>.ts`), false when imported — e.g. by a unit
 * test, which must not run the script's `main` (its git queries, its stdout)
 * on import.
 */
const isEntrypoint = (moduleUrl: string): boolean => {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

export { isEntrypoint }
