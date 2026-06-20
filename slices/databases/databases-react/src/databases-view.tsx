import { Effect } from 'effect'
import { formatBytes } from 'kitchen-sink'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { Dialog, ItemList, PageHeader, pageLayoutStyles, type ItemListItem } from 'react-tundraish'

import { describeDatabase } from './format.ts'
import type { DatabaseMetadata } from './queries.ts'

/** Right-aligned size/status chip for a row. */
const rowMeta = (database: DatabaseMetadata): string => {
  if (database.pendingDeletion) return 'Scheduled'
  if (database.exists) return formatBytes(database.sizeBytes)
  return 'Empty'
}

/** Row tint: danger while scheduled, neutral when present, none when absent. */
const rowTone = (database: DatabaseMetadata): 'neutral' | 'danger' | undefined => {
  if (database.pendingDeletion) return 'danger'
  if (database.exists) return 'neutral'
  return undefined
}

interface DatabasesViewProps {
  readonly databases: readonly DatabaseMetadata[]
  readonly onExport: (id: string) => void
  readonly onDelete: (id: string) => void
  /** The id currently exporting, if any (disables that row's buttons). */
  readonly exportingId: string | null
  /** The id currently deleting, if any. */
  readonly deletingId: string | null
  readonly errorMessage: string | null
}

/**
 * Presentational settings screen: one `ItemList` row per database with Download
 * + Delete actions, and a confirmation dialog gating the destructive delete.
 * Pure props in, callbacks out — the route screen wires the queries/mutations.
 */
const DatabasesView = ({
  databases,
  onExport,
  onDelete,
  exportingId,
  deletingId,
  errorMessage,
}: DatabasesViewProps): JSX.Element => {
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const confirmTarget = databases.find((database) => database.id === confirmId) ?? null

  const toItem = (database: DatabaseMetadata): ItemListItem => {
    const busy = exportingId === database.id || deletingId === database.id
    // A scheduled database is on its way out — no further export/delete until
    // the restart actually removes it.
    const locked = !database.exists || database.pendingDeletion
    return {
      id: database.id,
      title: database.label,
      // `describeDatabase` is Effect-returning (date formatting runs through
      // Effect's `DateTime`); it needs no services, so it runs synchronously.
      subtitle: Effect.runSync(describeDatabase(database)),
      meta: rowMeta(database),
      tone: rowTone(database),
      actions: (
        <>
          <button
            type="button"
            className="button-2 filled"
            disabled={locked || busy}
            onClick={() => onExport(database.id)}
          >
            {exportingId === database.id ? 'Downloading…' : 'Download'}
          </button>
          <button
            type="button"
            className="button-2 filled accent-red"
            disabled={locked || busy}
            onClick={() => setConfirmId(database.id)}
          >
            Delete
          </button>
        </>
      ),
    }
  }

  const hasPendingDeletion = databases.some((database) => database.pendingDeletion)

  return (
    <>
      <PageHeader title="Your data" backHref="/settings" backLabel="Settings" />
      <p className="text-body-3">
        Download a copy of a database to keep, or delete it from this device. Deleting your health
        data erases your clinical records here; deleting the app database resets access grants,
        tunnel settings, and the apps catalogue.
      </p>

      {hasPendingDeletion ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          A database is scheduled for deletion. <strong>Quit and reopen Wildflower</strong> to
          finish — until you do, the app will keep using it and may not work correctly.
        </p>
      ) : null}

      {errorMessage !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          {errorMessage}
        </p>
      ) : null}

      <ItemList items={databases.map((database) => toItem(database))} />

      <Dialog
        open={confirmTarget !== null}
        onClose={() => setConfirmId(null)}
        title={confirmTarget === null ? '' : `Delete ${confirmTarget.label}?`}
      >
        {confirmTarget !== null ? (
          <>
            <p className="text-body-3">
              This deletes <strong>{confirmTarget.id}</strong> from this device. It takes effect
              when you restart Wildflower, and can't be undone — download a copy first if you might
              want it back.
            </p>
            <div>
              <button type="button" className="button-2" onClick={() => setConfirmId(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="button-2 filled accent-red"
                disabled={deletingId === confirmTarget.id}
                onClick={() => {
                  onDelete(confirmTarget.id)
                  setConfirmId(null)
                }}
              >
                Delete
              </button>
            </div>
          </>
        ) : null}
      </Dialog>
    </>
  )
}

export { DatabasesView, type DatabasesViewProps }
