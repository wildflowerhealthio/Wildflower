/**
 * A batch's stored candidates (`StoredCandidates`), found once per batch: what
 * each referent's default link choice and the server diff read.
 *
 * @remarks
 * A TanStack query keyed by the batch id, so a settings re-decode does not
 * match the batch again. The screen blocks its first paint on it, so every
 * referent paints with its default already chosen.
 *
 * @packageDocumentation
 */

import { useQuery } from '@tanstack/react-query'
import { Option } from 'effect'
import { useMemo } from 'react'

import { useRunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { StoredCandidates } from '@wildflowerhealthio/importer-fundamentals'

import { IMPORTER_QUERY_KEY } from '../queries/keys.ts'

/** The batch's stored candidates as the review reads them, and the query's status. */
interface StoredCandidatesQuery {
  /** The stored candidates; `None` until they are in, and when the match failed. */
  readonly storedCandidates: Option.Option<StoredCandidates.Type>
  readonly isPending: boolean
  readonly isError: boolean
  readonly error: Error | null
}

/**
 * The stored candidates of `resources`, found once for `batchId`.
 *
 * @param batchId - The picked batch's id, which keys the query
 * @param resources - The resources of the batch's first decode; an empty
 *   list sends nothing
 * @returns The stored candidates and the query's status
 */
const useStoredCandidates = (
  batchId: number,
  resources: readonly FhirResourceWithId[]
): StoredCandidatesQuery => {
  const runAuthed = useRunAuthed()
  const query = useQuery({
    queryKey: [...IMPORTER_QUERY_KEY, 'stored-candidates', batchId] as const,
    queryFn: (): Promise<StoredCandidates.Type> => runAuthed(StoredCandidates.find(resources)),
    enabled: resources.length > 0,
    // A batch is matched once, and the batch is ephemeral.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })
  const storedCandidates = useMemo(() => Option.fromNullable(query.data), [query.data])
  return {
    storedCandidates,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
  }
}

export { useStoredCandidates }
