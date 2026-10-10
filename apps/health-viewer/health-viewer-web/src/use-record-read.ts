import { useInfiniteQuery } from '@tanstack/react-query'
import {
  fetchMedicationRequestPage,
  fetchObservationPage,
  type ResourcePage,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import {
  type RecordReading,
  type RecordResources,
  readRecord,
} from '@wildflowerhealthio/health-viewer-core-js'
import {
  type PagedQueryStatus,
  pagedQueryStatusOf,
  useFetchEveryPage,
} from '@wildflowerhealthio/react-kitchen-sink'
import { Effect } from 'effect'
import { useMemo } from 'react'

import type { SmartClient } from './smart-client.ts'

/**
 * Where a record read's page comes from: the patient scope, for the first
 * page — a patient's id, or `null` for every patient's — or a previous page's
 * `next` link, which already carries the scope.
 */
type RecordPageCursor = { readonly patientId: string | null } | { readonly pageUrl: string }

/**
 * One paged FHIR read feeding a record source: what the record read needs to
 * page it and name it.
 *
 * @typeParam TResource - The decoded resource the read's pages carry.
 */
interface RecordSourceRead<TResource> {
  /** The query key's first segment — distinct across the record's reads. */
  readonly queryName: string
  /** What a status line calls the read: `Could not load <subject>: …`. */
  readonly subject: string
  /** Fetch one page: the scope's first, or the one a `next` link points to. */
  readonly fetchPage: (
    client: SmartClient,
    cursor: RecordPageCursor
  ) => Effect.Effect<ResourcePage<TResource>, unknown>
}

/** The `Observation` read, oldest-observed first. */
const observationRead: RecordSourceRead<RecordResources['observations'][number]> = {
  queryName: 'observations',
  subject: 'observations',
  fetchPage: (client, cursor) =>
    fetchObservationPage(client, 'pageUrl' in cursor ? cursor : { first: cursor.patientId }),
}

/** The `MedicationRequest` read; an entry without an `id` is dropped and counted. */
const medicationRequestRead: RecordSourceRead<RecordResources['medicationRequests'][number]> = {
  queryName: 'medication-requests',
  subject: 'medication requests',
  fetchPage: fetchMedicationRequestPage,
}

/** One source's read as it stands: its status, what has landed, and what did not decode. */
interface RecordSourceReading<TResource> {
  readonly subject: string
  readonly status: PagedQueryStatus
  /** Every resource landed so far, in server order. */
  readonly resources: readonly TResource[]
  /** Entries the landed pages carried that did not decode. */
  readonly droppedEntryCount: number
}

/** A read that failed, named for its status line. */
interface RecordReadFailure {
  readonly subject: string
  readonly error: unknown
}

/**
 * The whole record read, as one value the page renders from:
 *
 * - `loading`: some read has no page yet, and none has failed its first.
 * - `failed`: a read's first page failed — the first such read, in source
 *   order; there is no record to show.
 * - `read`: every read has a page. `reading` is what has landed, read into
 *   series; `isComplete` holds once every read has its last page;
 *   `isLoadingMore` while any is still paging; `pageFailures` names each read
 *   halted by a failed later page, whose earlier pages are kept.
 *   `undatedCount` and `unreadableCount` are what the chart leaves out:
 *   inputs with no time, and inputs no source could read plus page entries
 *   that did not decode.
 */
type RecordRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: RecordReadFailure }
  | {
      readonly kind: 'read'
      readonly reading: RecordReading
      readonly isComplete: boolean
      readonly isLoadingMore: boolean
      readonly pageFailures: readonly RecordReadFailure[]
      readonly undatedCount: number
      readonly unreadableCount: number
    }

/**
 * Open `read` for `patientId` (`null` for every patient) and page it to the
 * end, concurrently with every other read, re-rendering as each page lands.
 */
const useRecordSourceRead = <TResource>(
  read: RecordSourceRead<TResource>,
  client: SmartClient,
  patientId: string | null
): RecordSourceReading<TResource> => {
  const firstPageCursor: RecordPageCursor = { patientId }
  const pagedQuery = useInfiniteQuery({
    queryKey: [read.queryName, patientId],
    queryFn: ({ pageParam }: { readonly pageParam: RecordPageCursor }) =>
      Effect.runPromise(read.fetchPage(client, pageParam)),
    initialPageParam: firstPageCursor,
    getNextPageParam: (lastPage): RecordPageCursor | undefined =>
      lastPage.nextPageUrl === null ? undefined : { pageUrl: lastPage.nextPageUrl },
  })
  useFetchEveryPage(pagedQuery)

  // `data` keeps a stable reference until a page is added, so these re-run
  // only when what has landed grows.
  const pages = pagedQuery.data?.pages
  const resources = useMemo(() => (pages ?? []).flatMap((page) => page.items), [pages])
  const droppedEntryCount = useMemo(
    () => (pages ?? []).reduce((total, page) => total + page.droppedEntryCount, 0),
    [pages]
  )
  return {
    subject: read.subject,
    status: pagedQueryStatusOf(pagedQuery),
    resources,
    droppedEntryCount,
  }
}

/**
 * Where the reads stand together, before what has landed is read into
 * series: {@link RecordRead}'s arms, with the `read` arm's left-out counts
 * still the pages' own undecoded entries.
 */
type RecordReadProgress =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly failure: RecordReadFailure }
  | {
      readonly kind: 'read'
      readonly isComplete: boolean
      readonly isLoadingMore: boolean
      readonly pageFailures: readonly RecordReadFailure[]
      readonly droppedEntryCount: number
    }

/**
 * Fold every source's reading into one progress: a first-page failure (the
 * first, in source order) over loading, loading over read.
 */
const recordReadProgressOf = (
  sourceReadings: readonly RecordSourceReading<unknown>[]
): RecordReadProgress => {
  const [firstPageFailure] = sourceReadings.flatMap(({ subject, status }) =>
    status.kind === 'failed' ? [{ subject, error: status.error }] : []
  )
  if (firstPageFailure !== undefined) return { kind: 'failed', failure: firstPageFailure }
  if (sourceReadings.some(({ status }) => status.kind === 'loading')) return { kind: 'loading' }
  return {
    kind: 'read',
    isComplete: sourceReadings.every(({ status }) => status.kind === 'complete'),
    isLoadingMore: sourceReadings.some(({ status }) => status.kind === 'paging'),
    pageFailures: sourceReadings.flatMap(({ subject, status }) =>
      status.kind === 'page-failed' ? [{ subject, error: status.error }] : []
    ),
    droppedEntryCount: sourceReadings.reduce(
      (total, source) => total + source.droppedEntryCount,
      0
    ),
  }
}

/**
 * Read a patient's whole record: every source's paged read, drained
 * concurrently, and what has landed read into series with `readRecord`.
 *
 * @param client - The SMART client every read is issued through.
 * @param patientId - The patient whose record is read, or `null` to read
 *   every patient's unscoped, as one record.
 * @returns The one {@link RecordRead} the page renders from.
 *
 * @remarks
 * Each source is one {@link RecordSourceRead}, its line in `sourceReadings`
 * and its resources in the `readRecord` call, both typed against
 * `health-viewer-core-js`'s `RecordResources`: when core adds a source, this
 * does not compile until its read is listed. Nothing else is per source —
 * status, completeness, failures and the left-out counts are folded over
 * every source alike by {@link recordReadProgressOf}.
 *
 * The progress is folded before `readRecord` is memoised, so nothing reads
 * the landed resources after the memo captures them.
 */
const useRecordRead = (client: SmartClient, patientId: string | null): RecordRead => {
  const sourceReadings = {
    observations: useRecordSourceRead(observationRead, client, patientId),
    medicationRequests: useRecordSourceRead(medicationRequestRead, client, patientId),
  } satisfies {
    readonly [Source in keyof RecordResources]: RecordSourceReading<RecordResources[Source][number]>
  }

  const progress = recordReadProgressOf(Object.values(sourceReadings))

  const observations = sourceReadings.observations.resources
  const medicationRequests = sourceReadings.medicationRequests.resources
  const reading = useMemo(
    () => readRecord({ observations, medicationRequests }),
    [observations, medicationRequests]
  )
  if (progress.kind !== 'read') return progress
  const { droppedEntryCount, ...readProgress } = progress
  return {
    ...readProgress,
    reading,
    undatedCount: reading.undated,
    unreadableCount: reading.dropped + droppedEntryCount,
  }
}

export { useRecordRead, type RecordRead, type RecordReadFailure }
