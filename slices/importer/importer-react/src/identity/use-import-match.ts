/**
 * The stored records a batch's records match, found once per batch, the
 * default link choice of every referent read off them, and the stored lists
 * the referent rows offer, started beside it.
 *
 * @remarks
 * The match is `ImportMatch.find` over every record of the batch's first
 * decode, a TanStack query keyed by the batch id and read once per batch:
 * one `ResourceMatch.matchAll` for the whole batch. Each referent's default
 * is `ReferentMatch.defaultChoices` over it, and the server diff reads each
 * record's matched copy from it too (`useServerDiff`). The screen blocks the
 * first paint on it, as it does on the server diff, so every line paints with
 * its default already chosen. The stored lists the rows offer are read in the
 * same breath (prefetched under `storedResourcesQuery`), since they depend
 * on neither.
 *
 * @packageDocumentation
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Array, Effect, HashMap, Option, pipe } from 'effect'
import { useEffect, useMemo } from 'react'

import { useRunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import {
  ImportMatch,
  LinkableLogicalReference,
  LinkChoice,
  LinkableResource,
  type Referent,
  ReferentLinkChoiceSet,
  ReferentMatch,
} from '@wildflowerhealthio/importer-fundamentals'

import { IMPORTER_QUERY_KEY } from '../queries/keys.ts'
import {
  labeled,
  type StoredResource,
  storedResourcesQuery,
} from './use-stored-resources-of-type.ts'

/** What the defaults are: each referent's choice, and the stored resources they link to, labelled. */
interface MatchedDefaults {
  readonly linkChoices: ReferentLinkChoiceSet.Type
  readonly found: readonly StoredResource[]
}

const NO_DEFAULTS: MatchedDefaults = { linkChoices: ReferentLinkChoiceSet.empty, found: [] }

/** The first decode of a batch: its referents and every record it holds, the ones the match reads. */
interface FirstDecode {
  readonly referents: readonly Referent.Type[]
  readonly records: readonly FhirResourceWithId[]
}

/** What the match query answers with: the match, and the defaults read off it. */
interface MatchedBatch {
  readonly importMatch: ImportMatch.Type
  readonly defaults: MatchedDefaults
}

/**
 * The match of `firstDecode`'s records, each referent's own record matched
 * first, the default choice of every referent read off it, and each stored
 * resource those defaults link to or update, once, labelled.
 */
const matchBatch = ({
  referents,
  records,
}: FirstDecode): Effect.Effect<
  MatchedBatch,
  Effect.Effect.Error<ReturnType<typeof ImportMatch.find>>,
  Effect.Effect.Context<ReturnType<typeof ImportMatch.find>>
> =>
  Effect.gen(function* () {
    const importMatch = yield* ImportMatch.find([
      ...referents.map(({ resource }) => resource),
      ...records,
    ])
    const linkChoices = ReferentMatch.defaultChoices(referents, importMatch)
    const found = yield* pipe(
      Array.fromIterable(HashMap.values(linkChoices)),
      Array.filterMap((choice) =>
        LinkChoice.is('LinkToStoredResource')(choice) ||
        LinkChoice.is('UpdateStoredResource')(choice)
          ? Option.some(choice.resource)
          : Option.none()
      ),
      Array.dedupeWith(LinkableResource.sameRecord),
      Effect.forEach(labeled)
    )
    return { importMatch, defaults: { linkChoices, found } }
  })

/** The batch's match as the review reads it: the match (`None` until it is in, or when it failed), the defaults and the query's status. */
interface ImportMatchQuery {
  readonly importMatch: Option.Option<ImportMatch.Type>
  readonly defaults: MatchedDefaults
  readonly isPending: boolean
  readonly isError: boolean
  readonly error: Error | null
}

/**
 * The match of `firstDecode`, read once for `batchId`, the defaults read off
 * it, and the stored lists of its referents' types started.
 *
 * @param batchId - The picked batch's id, which keys the match
 * @param firstDecode - The referents and records of the batch's first
 *   decode, or none while no batch is in hand
 * @returns The match, the defaults and the query's status
 */
const useImportMatch = (batchId: number, firstDecode: FirstDecode): ImportMatchQuery => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  const { referents, records } = firstDecode

  // The stored lists the rows will offer start loading now, beside the
  // match, rather than when the rows mount after it. A list that fails is
  // reported by the rows' own read of the same query, so this start of it
  // reports nothing.
  useEffect(() => {
    for (const resourceType of LinkableLogicalReference.RESOURCE_TYPES) {
      if (referents.some((referent) => referent.logicalReference.resourceType === resourceType)) {
        queryClient.query(storedResourcesQuery(resourceType, runAuthed)).catch(() => undefined)
      }
    }
  }, [queryClient, runAuthed, referents])

  const query = useQuery({
    queryKey: [...IMPORTER_QUERY_KEY, 'import-match', batchId] as const,
    queryFn: (): Promise<MatchedBatch> => runAuthed(matchBatch(firstDecode)),
    enabled: records.length > 0,
    // The match is read once per batch; the batch is ephemeral.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })

  const importMatch = useMemo(
    () => Option.map(Option.fromNullable(query.data), ({ importMatch: matched }) => matched),
    [query.data]
  )

  return {
    importMatch,
    defaults: query.data?.defaults ?? NO_DEFAULTS,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
  }
}

export { type FirstDecode, useImportMatch }
