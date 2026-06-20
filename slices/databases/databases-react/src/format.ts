import { DateTime, Effect } from 'effect'

import type { DatabaseMetadata } from './queries.ts'

/**
 * The "fun metadata" line under each database: table count + last-modified.
 *
 * Returns an `Effect` so the date rendering runs through Effect's `DateTime`
 * (`modifiedAt` is decoded as a `DateTime.Utc`), leaving a seam to draw the
 * locale/zone from context later. Today it needs no services, so the view runs
 * it synchronously.
 */
const describeDatabase = (database: DatabaseMetadata): Effect.Effect<string> =>
  Effect.sync(() => {
    if (!database.exists) return `${database.description} · Not created yet`
    const tables =
      database.tableCount === undefined
        ? null
        : `${database.tableCount} ${database.tableCount === 1 ? 'table' : 'tables'}`
    const modified =
      database.modifiedAt === undefined
        ? null
        : `updated ${DateTime.format(database.modifiedAt, { dateStyle: 'medium' })}`
    const extras = [tables, modified].filter((part): part is string => part !== null).join(' · ')
    return extras === '' ? database.description : `${database.description} · ${extras}`
  })

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

export { describeDatabase, saveBytesAsFile }
