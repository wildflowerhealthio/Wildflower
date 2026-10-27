import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Array, Effect, Either, HashMap, Option, pipe } from 'effect'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useRunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import {
  applyIdentityMap,
  type BatchDecodeResult,
  claimedFormats,
  discoverReferents,
} from '@wildflowerhealthio/importer-core'
import {
  LinkableLogicalReference,
  LinkChoice,
  LinkableResource,
  LinkPlan,
  type LinkTarget,
  Referent,
  ReferentLinkChoices,
  ReferentSearch,
} from '@wildflowerhealthio/importer-fundamentals'

import { IMPORTER_QUERY_KEY } from '../queries/keys.ts'
import { labeled, type StoredResource, storedResourcesQuery } from './use-stored-resources.ts'

/**
 * The identity map in the screen: the batch's referents, the link choice each
 * one takes, and the batch placed on those choices, which is what the server
 * diff, the preview and the confirm all see.
 *
 * @remarks
 * Each referent's default is `ReferentSearch.defaultChoices`, a TanStack query
 * keyed by the batch id and read once per batch, over the referents of the
 * batch's first decode. The screen blocks the first paint on it, as it does on
 * the server diff, so every line paints with its search hit already chosen.
 * The stored lists the rows offer are read in the same breath (prefetched
 * under `storedResourcesQuery`), since they depend on neither.
 * The reviewer's choices sit on top of the defaults, keyed by `Referent.key`,
 * and survive a settings re-decode: a re-decode re-discovers the referents,
 * and a referent it brings back keeps its choice. A choice the stage can no
 * longer follow after a re-decode (its referent changed kind, or the referent
 * it linked to is gone) is dropped, so the referent takes its default. A fresh
 * pick starts over.
 *
 * The stage's failures surface as states: a failed search is `error` (every
 * referent takes its kind's default and the screen says so), and a batch two
 * decoded resources of one identity refuse (`Referent.DuplicateReferent`) is
 * `refused`, carrying the last placing of the batch that succeeded when a
 * re-decode is what refused it.
 *
 * @packageDocumentation
 */

/** The identity map of a batch, as the screen renders and places it. */
interface Mapped {
  /** Every referent of the batch, once per identity (`discoverReferents`). */
  readonly referents: readonly Referent.Type[]
  /** The choices the batch is placed on: the defaults, under the reviewer's own, less any the stage cannot follow. */
  readonly linkChoices: ReferentLinkChoices.Type
  /** Each referent's link target under {@link linkChoices}, by `Referent.key`. */
  readonly linkTargets: HashMap.HashMap<string, LinkTarget.Type>
  /** The stored resources the default search found, linked to or updated, labelled, for the reviewer to pick again. */
  readonly found: readonly StoredResource[]
  /** The batch placed on {@link linkChoices}: what the diff, the preview and the confirm see. */
  readonly placed: BatchDecodeResult
}

/**
 * `loading` while the default search for this batch is in flight (the screen
 * paints a status line instead of the preview), `ready` once the defaults are
 * in, `error` when the search failed and every referent took its kind's
 * default, `refused` when the batch cannot be placed at all, with the last
 * placing of this batch that could be, when a re-decode is what refused it,
 * so the screen can keep that review up while the reviewer undoes the change.
 */
type IdentityMapState =
  | { readonly _tag: 'loading' }
  | ({ readonly _tag: 'ready' } & Mapped)
  | ({ readonly _tag: 'error'; readonly error: Error } & Mapped)
  | {
      readonly _tag: 'refused'
      readonly failure: Referent.DuplicateReferent
      readonly previous: Option.Option<Mapped>
    }

/** The hook's surface: the state, and the one action the referent rows drive. */
interface IdentityMapReview {
  readonly state: IdentityMapState
  /** Set the reviewer's choice for the referent keyed `referentKey`. */
  readonly choose: (referentKey: string, choice: LinkChoice.Type) => void
}

/** What the hook holds per picked batch, reset when the batch id changes. */
interface PerBatch {
  readonly batchId: number
  /** The referents of the batch's first decode: the ones the default search reads. */
  readonly searched: readonly Referent.Type[]
  readonly chosen: ReferentLinkChoices.Type
}

/** What the default search answers with: the defaults, and the stored resources they link to, labelled. */
interface SearchedDefaults {
  readonly linkChoices: ReferentLinkChoices.Type
  readonly found: readonly StoredResource[]
}

const NO_DEFAULTS: SearchedDefaults = { linkChoices: ReferentLinkChoices.empty, found: [] }

/** No referents to search for, held once so the effects keyed on it do not re-run. */
const NO_REFERENTS: readonly Referent.Type[] = []

/** The default choice of every referent of `referents`, and each stored resource those defaults link to or update, once. */
const searchDefaults = (
  referents: readonly Referent.Type[]
): Effect.Effect<
  SearchedDefaults,
  ReferentSearch.SearchFailure,
  Effect.Effect.Context<ReturnType<typeof ReferentSearch.defaultChoices>>
> =>
  Effect.gen(function* () {
    const linkChoices = yield* ReferentSearch.defaultChoices(referents)
    const found = yield* pipe(
      Array.fromIterable(HashMap.values(linkChoices)),
      Array.filterMap((choice) =>
        LinkChoice.is('LinkToStoredResource')(choice) ||
        LinkChoice.is('UpdateStoredResource')(choice)
          ? Option.some(choice.resource)
          : Option.none()
      ),
      Array.dedupeWith(
        (left, right) =>
          LinkableResource.literalReferenceOf(left) === LinkableResource.literalReferenceOf(right)
      ),
      Effect.forEach(labeled)
    )
    return { linkChoices, found }
  })

/** The decoded batch placed on choices the stage can follow. */
interface Placed {
  readonly linkChoices: ReferentLinkChoices.Type
  readonly linkTargets: HashMap.HashMap<string, LinkTarget.Type>
  readonly batch: BatchDecodeResult
}

/**
 * `batch` placed on the reviewer's `chosen` choices over the searched
 * `defaults`, less every choice the stage cannot follow (a re-decode may have
 * changed a referent's kind, or removed the referent a choice linked to).
 *
 * @remarks
 * Each failure names the choice the stage could not follow. The reviewer's
 * own choice for that referent goes first, so the referent falls back to its
 * searched default; a default that cannot be followed either goes next, so
 * it falls back to its kind's default. A failure naming a referent with no
 * choice at all is a defect in the stage's defaults, so it dies rather than
 * loop.
 */
const placeFollowableChoices = (
  batch: BatchDecodeResult,
  defaults: ReferentLinkChoices.Type,
  chosen: ReferentLinkChoices.Type
): Effect.Effect<Placed, Referent.DuplicateReferent> => {
  const linkChoices = HashMap.union(defaults, chosen)
  return Effect.all({
    batch: applyIdentityMap(batch, linkChoices),
    plan: LinkPlan.make(
      claimedFormats(batch).map((kind) => batch[kind].decoded),
      linkChoices
    ),
  }).pipe(
    Effect.map(({ batch: placedBatch, plan }) => ({
      linkChoices,
      linkTargets: HashMap.fromIterable(
        plan.links.map(({ referent, target }) => [Referent.key(referent), target] as const)
      ),
      batch: placedBatch,
    })),
    Effect.catchTag('InvalidLinkChoice', (failure) => {
      if (HashMap.has(chosen, failure.referentKey)) {
        return placeFollowableChoices(batch, defaults, HashMap.remove(chosen, failure.referentKey))
      }
      if (HashMap.has(defaults, failure.referentKey)) {
        return placeFollowableChoices(batch, HashMap.remove(defaults, failure.referentKey), chosen)
      }
      return Effect.die(
        new Error(
          `a kind's default choice could not be followed: ${failure.reason} for ${failure.referentKey}`
        )
      )
    })
  )
}

/**
 * The batch's identity map: its referents, their defaults from one search per
 * referent, the reviewer's choices, and the placed batch.
 *
 * @param batch - The decoded batch (undefined until the read is `ready`)
 * @param batchId - The picked batch's id: stable across a settings re-decode,
 *   new for a fresh pick
 * @returns The state and the `choose` action
 */
const useIdentityMap = (
  batch: BatchDecodeResult | undefined,
  batchId: number
): IdentityMapReview => {
  const runAuthed = useRunAuthed()
  const queryClient = useQueryClient()
  // Discovery reads the clock (which of a person's names is current) and
  // nothing else, so it runs synchronously here; its one failure is a state.
  const discovered = useMemo(
    (): Either.Either<readonly Referent.Type[], Referent.DuplicateReferent> | undefined =>
      batch === undefined ? undefined : Effect.runSync(Effect.either(discoverReferents(batch))),
    [batch]
  )
  const referents = discovered === undefined ? undefined : Either.getOrUndefined(discovered)

  // Captured on the batch's first decode and adjusted during render off the
  // changed batch id (the "derive from a changed prop" pattern), so a
  // re-decode neither re-searches nor drops the reviewer's choices.
  const [perBatch, setPerBatch] = useState<PerBatch | undefined>(undefined)
  let current = perBatch
  if (referents !== undefined && current?.batchId !== batchId) {
    current = { batchId, searched: referents, chosen: ReferentLinkChoices.empty }
    setPerBatch(current)
  }
  // Only while a batch is in hand: after a start-over or during the next
  // pick's read, the previous batch's referents must not be searched again.
  const searched = referents === undefined ? NO_REFERENTS : (current?.searched ?? NO_REFERENTS)

  // The stored lists the rows will offer start loading now, beside the
  // default search, rather than when the rows mount after it. A list that
  // fails is reported by the rows' own read of the same query, so this start
  // of it reports nothing.
  useEffect(() => {
    for (const resourceType of LinkableLogicalReference.RESOURCE_TYPES) {
      if (searched.some((referent) => referent.logicalReference.type === resourceType)) {
        queryClient.query(storedResourcesQuery(resourceType, runAuthed)).catch(() => undefined)
      }
    }
  }, [queryClient, runAuthed, searched])

  const query = useQuery({
    queryKey: [...IMPORTER_QUERY_KEY, 'referent-defaults', batchId] as const,
    queryFn: (): Promise<SearchedDefaults> => runAuthed(searchDefaults(searched)),
    enabled: searched.length > 0,
    // The defaults are read once per batch; the batch is ephemeral.
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  })

  const defaults = query.data ?? NO_DEFAULTS
  const chosen = current?.chosen ?? ReferentLinkChoices.empty
  const loading = batch === undefined || (searched.length > 0 && query.isPending)

  const mapped = useMemo((): Either.Either<Mapped, Referent.DuplicateReferent> | undefined => {
    if (loading || batch === undefined || discovered === undefined) return undefined
    return Either.flatMap(discovered, (discoveredReferents) =>
      Either.map(
        Effect.runSync(Effect.either(placeFollowableChoices(batch, defaults.linkChoices, chosen))),
        (placed): Mapped => ({
          referents: discoveredReferents,
          linkChoices: placed.linkChoices,
          linkTargets: placed.linkTargets,
          found: defaults.found,
          placed: placed.batch,
        })
      )
    )
  }, [loading, batch, discovered, defaults, chosen])

  // The last placing of this batch that succeeded, kept (and adjusted during
  // render, as above) so a refusal after a re-decode is shown over it.
  const [lastReady, setLastReady] = useState<
    { readonly batchId: number; readonly mapped: Mapped } | undefined
  >(undefined)
  const readyNow = mapped === undefined ? undefined : Either.getOrUndefined(mapped)
  if (readyNow !== undefined && lastReady?.mapped !== readyNow) {
    setLastReady({ batchId, mapped: readyNow })
  }
  const previous = useMemo(
    (): Option.Option<Mapped> =>
      lastReady?.batchId === batchId ? Option.some(lastReady.mapped) : Option.none(),
    [lastReady, batchId]
  )

  const choose = useCallback((referentKey: string, choice: LinkChoice.Type): void => {
    setPerBatch((perBatchBefore) =>
      perBatchBefore === undefined
        ? perBatchBefore
        : { ...perBatchBefore, chosen: HashMap.set(perBatchBefore.chosen, referentKey, choice) }
    )
  }, [])

  const state = useMemo((): IdentityMapState => {
    if (discovered !== undefined && Either.isLeft(discovered)) {
      return { _tag: 'refused', failure: discovered.left, previous }
    }
    if (mapped === undefined) return { _tag: 'loading' }
    return Either.match(mapped, {
      onLeft: (failure): IdentityMapState => ({ _tag: 'refused', failure, previous }),
      onRight: (ready): IdentityMapState =>
        query.isError
          ? {
              _tag: 'error',
              error:
                query.error instanceof Error
                  ? query.error
                  : new Error('Failed to search the server for referents'),
              ...ready,
            }
          : { _tag: 'ready', ...ready },
    })
  }, [discovered, mapped, previous, query.isError, query.error])

  return { state, choose }
}

export { type IdentityMapReview, type IdentityMapState, type Mapped, useIdentityMap }
