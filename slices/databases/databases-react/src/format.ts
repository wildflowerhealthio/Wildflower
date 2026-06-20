import type { DatabaseMetadata } from './queries.ts'

/** Human-readable byte size, e.g. `1.4 MB`. Binary (1024) units. */
const humanizeBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value < 10 ? value.toFixed(1) : String(Math.round(value))
  return `${rounded} ${units[unit]}`
}

/** The "fun metadata" line under each database: table count + last-modified. */
const describeDatabase = (database: DatabaseMetadata): string => {
  if (!database.exists) return `${database.description} · Not created yet`
  const tables =
    database.tableCount === undefined
      ? null
      : `${database.tableCount} ${database.tableCount === 1 ? 'table' : 'tables'}`
  const modified =
    database.modifiedAt === undefined
      ? null
      : `updated ${new Date(database.modifiedAt).toLocaleDateString()}`
  const extras = [tables, modified].filter((part): part is string => part !== null).join(' · ')
  return extras === '' ? database.description : `${database.description} · ${extras}`
}

/**
 * Hand a database export to the browser as a downloaded file. Builds a Blob from
 * the bytes, clicks a transient object-URL anchor, then revokes it.
 */
const saveBytesAsFile = (bytes: Uint8Array<ArrayBuffer>, filename: string): void => {
  const blob = new Blob([bytes], { type: 'application/vnd.sqlite3' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export { describeDatabase, humanizeBytes, saveBytesAsFile }
