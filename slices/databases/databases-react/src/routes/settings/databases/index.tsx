import { createFileRoute } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView, useErrorBodyRenderer } from 'react-tundraish'

import { DatabasesView } from '../../../databases-view.tsx'
import { saveBytesAsFile } from '../../../format.ts'
import {
  databasesQueryOptions,
  useDatabasesQuery,
  useDeleteDatabaseMutation,
  useExportDatabaseMutation,
} from '../../../queries.ts'

/** Wires the suspense query + mutations to {@link DatabasesView}. */
const DatabasesScreen = (): JSX.Element => {
  const { data: databases } = useDatabasesQuery()
  const exportMutation = useExportDatabaseMutation()
  const deleteMutation = useDeleteDatabaseMutation()

  // A failed mutation (e.g. a `403 InsufficientScope` on delete) renders through
  // the same app-provided error renderer the route's `errorComponent` uses — so
  // it gets the scope-naming surface — falling back to the plain message banner
  // for everything else.
  const renderError = useErrorBodyRenderer()
  const error = exportMutation.error ?? deleteMutation.error
  const errorSurface = error === null ? null : (renderError?.(error) ?? null)
  const errorMessage = error === null || errorSurface !== null ? null : error.message

  return (
    <DatabasesView
      databases={databases}
      exportingId={exportMutation.isPending ? (exportMutation.variables?.id ?? null) : null}
      deletingId={deleteMutation.isPending ? (deleteMutation.variables?.id ?? null) : null}
      errorMessage={errorMessage}
      errorSurface={errorSurface}
      onExport={(id) => {
        exportMutation.mutate(
          { id },
          { onSuccess: ({ bytes, filename }) => saveBytesAsFile(bytes, filename) }
        )
      }}
      onDelete={(id) => {
        deleteMutation.mutate({ id })
      }}
    />
  )
}

/**
 * The `/settings/databases` file route. The `/settings` `beforeLoad` gate
 * guarantees a token before this loader runs, so it's a plain `ensureQueryData`
 * — failures propagate to `errorComponent`.
 */
export const Route = createFileRoute('/settings/databases/')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(databasesQueryOptions(context.runAuthed)),
  component: DatabasesScreen,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Your data" />,
})
