import {
  infiniteQueryOptions,
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query'
import type { DateTime } from 'effect'
import { Array as Arr, Effect, Option } from 'effect'
import type { RunAuthed } from 'fhir-r4-react'
import { useRunAuthed } from 'fhir-r4-react'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import {
  HAR_ARCHIVE_CODE,
  harArchiveFromDocumentReference,
  isHarArchive,
  WEB_TRACE_CODE_SYSTEM,
  type DocumentReferenceType,
} from 'web-trace-core/codec'

import { type PickedHar, serverSource } from '../sources/picked-har.ts'
import { HAR_ARCHIVES_QUERY_KEY } from './keys.ts'
import { nextPageToken } from './page-token.ts'

/**
 * The paged read behind the server source: HAR archive `DocumentReference`s off
 * the device's own FHIR server, listed as rows and fetched whole only when one
 * is selected.
 *
 * @remarks
 * The search is by `category`, the axis a HAR archive is reachable on — an
 * archive carries no `subject`, deliberately, so it stays out of a patient read.
 * The list holds only what a row shows (title, upload instant); the archive's
 * bytes are large and are fetched one at a time, by {@link fetchHarArchive}, when
 * the user picks a row. The archive category is disjoint from the web-trace
 * category, so this list never returns a trace and the viewer's list never
 * returns an archive — the two predicates test different codes on one axis.
 *
 * @packageDocumentation
 */

/**
 * The `category` token the search filters on, in FHIR's `system|code` form so a
 * bare `har-archive` code in some other system cannot match.
 *
 * @remarks
 * Built from `web-trace-core`'s constants rather than spelled out: the archive
 * codec writes this coding, and a second literal here would drift from it the
 * moment either moved.
 */
const HAR_ARCHIVE_CATEGORY_TOKEN = `${WEB_TRACE_CODE_SYSTEM}|${HAR_ARCHIVE_CODE}`

/**
 * How many archive `DocumentReference`s one page requests.
 *
 * @remarks
 * A page is one round trip. Large enough that a device holding a handful of
 * uploaded archives lists them in one page, small enough that a long history
 * paints its first rows without waiting on the rest.
 */
const DEFAULT_PAGE_SIZE = 50

/**
 * One archive as the list shows it: enough to name and date a row, and its id so
 * a selection can fetch the whole archive and build its `server` source.
 *
 * @remarks
 * Deliberately not the archive itself. The bytes are the file, potentially many
 * megabytes; listing them all to render a title would pull every archive onto
 * the device to show a list. The row carries the id, and {@link fetchHarArchive}
 * reads the one the user chose.
 */
interface HarArchiveRow {
  /** The archive `DocumentReference`'s logical id. */
  readonly id: string
  /** The archive's title — its original file name — or `null` when it carries none. */
  readonly title: string | null
  /** When the archive was uploaded, or `null` when the resource states no instant. */
  readonly creation: DateTime.Utc | null
}

/** One page of archive rows, plus the cursor for the next page. */
interface HarArchivePage {
  /** The archives on this page, in the order the server sent them. */
  readonly archives: readonly HarArchiveRow[]
  /** The cursor for the following page, or `undefined` at the end of the searchset. */
  readonly nextPageToken: string | undefined
}

/** The cursor type paging carries; `null` is the first page, not a page named null. */
type ArchivePageParam = string | null

/** Query key for the paged read, distinguished by page size. */
type HarArchivesQueryKey = readonly [
  ...typeof HAR_ARCHIVES_QUERY_KEY,
  { readonly pageSize: number },
]

/** Options for {@link harArchivesInfiniteQueryOptions} and {@link useHarArchivesQuery}. */
interface HarArchivesQueryOptions {
  /**
   * How many resources to request per page.
   *
   * @defaultValue 50
   */
  readonly pageSize?: number
}

/**
 * Projects a searchset bundle's entries into archive rows.
 *
 * @param entries - The bundle's entries, whose `resource` may be absent
 * @returns One {@link HarArchiveRow} per entry that is an archive with an id
 *
 * @remarks
 * A resource that is not a HAR archive is dropped — the category search should
 * return only archives, but the predicate is the guarantee, not the query. An
 * archive with no logical id is dropped too: a row exists to be selected, and a
 * selection needs an id to fetch by. The title and upload instant are read
 * straight off the attachment; neither decodes the bytes, so listing a page
 * never pulls a single archive's contents onto the device.
 */
const rowsOf = (
  entries: readonly { readonly resource: DocumentReferenceType | null }[]
): readonly HarArchiveRow[] =>
  Arr.filterMap(entries, (entry): Option.Option<HarArchiveRow> => {
    const resource = entry.resource
    if (resource === null || !isHarArchive(resource) || resource.id === null) return Option.none()
    const attachment = resource.content[0]?.attachment
    return Option.some({
      id: resource.id,
      title: attachment?.title ?? null,
      creation: attachment?.creation ?? null,
    })
  })

/**
 * Query options for the paged archive read, for a caller that drives the query
 * itself (a route loader, a test through `QueryClient`).
 *
 * @param runAuthed - The authed runner from router context
 * @param options - Page size
 * @returns Infinite-query options whose pages are {@link HarArchivePage}s
 *
 * @remarks
 * A bundle with no `next` link has no cursor, so `getNextPageParam` returns
 * `null` — which TanStack Query reads as "no further pages".
 */
const harArchivesInfiniteQueryOptions = (
  runAuthed: RunAuthed,
  options?: HarArchivesQueryOptions
): UseInfiniteQueryOptions<
  HarArchivePage,
  Error,
  InfiniteData<HarArchivePage, ArchivePageParam>,
  HarArchivesQueryKey,
  ArchivePageParam
> => {
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE
  return infiniteQueryOptions({
    queryKey: [...HAR_ARCHIVES_QUERY_KEY, { pageSize }] as const,
    initialPageParam: null as ArchivePageParam,
    getNextPageParam: (lastPage: HarArchivePage): ArchivePageParam =>
      lastPage.nextPageToken ?? null,
    queryFn: ({ pageParam }: { readonly pageParam: ArchivePageParam }): Promise<HarArchivePage> =>
      runAuthed(
        Effect.gen(function* () {
          const client = yield* FhirR4ResourcesHttpApiClient
          const bundle = yield* client.DocumentReference.SearchByGet({
            urlParams: {
              category: HAR_ARCHIVE_CATEGORY_TOKEN,
              _count: pageSize,
              ...(pageParam === null ? {} : { _pageToken: pageParam }),
            },
          })
          return {
            archives: rowsOf(bundle.entry),
            nextPageToken: nextPageToken(bundle.link),
          }
        })
      ),
  })
}

/**
 * Lists the device's uploaded HAR archives, one page at a time. The authed
 * runner comes from router context via `fhir-r4-react`'s `useRunAuthed`.
 *
 * @param options - Page size
 * @returns The infinite query; `data.pages` are {@link HarArchivePage}s in the
 *   order they were fetched
 */
const useHarArchivesQuery = (
  options?: HarArchivesQueryOptions
): UseInfiniteQueryResult<InfiniteData<HarArchivePage, ArchivePageParam>, Error> =>
  useInfiniteQuery(harArchivesInfiniteQueryOptions(useRunAuthed(), options))

/**
 * Fetches one archive whole and reads it back as a {@link PickedHar}.
 *
 * @param runAuthed - The authed runner from router context
 * @param id - The archive `DocumentReference`'s logical id, from a row
 * @returns The archive's HAR text and a `server` source pointing back at it
 *
 * @remarks
 * Runs the archive codec's `harArchiveFromDocumentReference`, so the bytes are
 * read the one way they are written and a resource that is not an archive fails
 * as a `ParseError` rather than yielding nonsense. The bytes are decoded to text
 * with `TextDecoder` — a HAR is UTF-8 JSON — and the `server` source carries the
 * archive's own reference so a later step links provenance to the stored archive
 * instead of uploading the same bytes again.
 */
const fetchHarArchive = (runAuthed: RunAuthed, id: string): Promise<PickedHar> =>
  runAuthed(
    Effect.gen(function* () {
      const client = yield* FhirR4ResourcesHttpApiClient
      const resource = yield* client.DocumentReference.GetById({ path: { id } })
      const archive = yield* harArchiveFromDocumentReference(resource)
      return {
        fileName: archive.fileName,
        text: new TextDecoder().decode(archive.bytes),
        source: serverSource(id),
      }
    })
  )

export {
  type ArchivePageParam,
  DEFAULT_PAGE_SIZE,
  fetchHarArchive,
  HAR_ARCHIVE_CATEGORY_TOKEN,
  type HarArchivePage,
  type HarArchiveRow,
  harArchivesInfiniteQueryOptions,
  type HarArchivesQueryKey,
  type HarArchivesQueryOptions,
  useHarArchivesQuery,
}
