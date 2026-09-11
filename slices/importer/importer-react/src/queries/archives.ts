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
import type { DocumentReferenceType } from 'importer-fundamentals'

import { formatKinds, formatRegistry, type FormatKind } from '../registry.ts'
import { type PickedFile, serverSource } from '../sources/picked-file.ts'
import { ARCHIVES_QUERY_KEY } from './keys.ts'
import { nextPageToken } from './page-token.ts'

/**
 * The paged read behind the server source: uploaded archive
 * `DocumentReference`s off the device's own FHIR server, across every
 * registered format, listed as rows and fetched whole only when one is
 * selected.
 *
 * @remarks
 * One search per page over every registered format's archive category token,
 * joined with FHIR's comma-OR (`category=t1,t2`), so the whole cross-format
 * listing is one round trip per page. Each returned resource is classified
 * by dispatching every descriptor's `isArchive` predicate in registry order;
 * predicates are disjoint by construction (HAR under `WEB_TRACE_CODE_SYSTEM`,
 * LifeLabs under `LIFELABS_SYSTEM`) so at most one claims any row, and a row
 * no predicate claims (the coding matched the search but is from an
 * unregistered format) is dropped.
 *
 * The list holds only what a row shows (title, upload instant, format tag);
 * an archive's bytes are large and are fetched one at a time, by
 * {@link fetchArchive}, when the user picks a row or opens its preview.
 * Archive categories are disjoint from the web-trace trace category on
 * the same axis, so this list never returns a trace and the web-trace
 * viewer's list never returns an archive.
 *
 * @packageDocumentation
 */

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
 * The comma-joined `system|code` search value covering every registered
 * format's archive category token — the one value the server-side search
 * filters on.
 *
 * @remarks
 * Built once at module load from `formatRegistry`, in registry order, so
 * the shape stays a single source of truth (add a format to the registry,
 * its token joins this string). FHIR's search grammar is "AND across
 * parameters, OR within a comma-joined value", so this asks for a
 * `DocumentReference` matching *any* of the tokens.
 */
const ARCHIVES_CATEGORY_TOKEN = formatKinds
  .map((kind) => formatRegistry[kind].archiveCategoryToken)
  .join(',')

/**
 * One archive as the list shows it: enough to name and date a row, its id
 * so a selection can fetch the whole archive and build its `server`
 * source, and the format tag the row was classified as so a preview or
 * pick dispatches to the right descriptor.
 *
 * @remarks
 * Deliberately not the archive itself. The bytes are the file, potentially
 * many megabytes; listing them all to render a title would pull every
 * archive onto the device to show a list. The row carries the id and the
 * format; {@link fetchArchive} reads the one the user chose.
 */
interface ArchiveRow {
  /** The archive `DocumentReference`'s logical id. */
  readonly id: string
  /**
   * Which registered format this archive is, by the `isArchive` predicate
   * that claimed it. Drives the preview modal's renderer choice and the
   * fetch's decoder.
   */
  readonly format: FormatKind
  /** The archive's title — its original file name — or `null` when it carries none. */
  readonly title: string | null
  /** When the archive was uploaded, or `null` when the resource states no instant. */
  readonly creation: DateTime.Utc | null
}

/** One page of archive rows, plus the cursor for the next page. */
interface ArchivePage {
  /** The archives on this page, in the order the server sent them. */
  readonly archives: readonly ArchiveRow[]
  /** The cursor for the following page, or `undefined` at the end of the searchset. */
  readonly nextPageToken: string | undefined
}

/** The cursor type paging carries; `null` is the first page, not a page named null. */
type ArchivePageParam = string | null

/** Query key for the paged read, distinguished by page size. */
type ArchivesQueryKey = readonly [...typeof ARCHIVES_QUERY_KEY, { readonly pageSize: number }]

/** Options for {@link archivesInfiniteQueryOptions} and {@link useArchivesQuery}. */
interface ArchivesQueryOptions {
  /**
   * How many resources to request per page.
   *
   * @defaultValue 50
   */
  readonly pageSize?: number
}

/**
 * The first registered format whose `isArchive` claims the resource, or
 * `undefined` when none does.
 *
 * @remarks
 * Predicates are disjoint by construction (each tests a different
 * `system|code` on the `category` axis), so first-match is the only match.
 * Iteration is in registry order — the format-kind literal walk, not the
 * `Object.keys(formatRegistry)` order — so the classification is
 * deterministic across engines.
 */
const classifyArchive = (resource: DocumentReferenceType): FormatKind | undefined =>
  formatKinds.find((kind) => formatRegistry[kind].isArchive(resource))

/**
 * Projects a searchset bundle's entries into archive rows.
 *
 * @param entries - The bundle's entries, whose `resource` may be absent
 * @returns One {@link ArchiveRow} per entry that is an archive of a
 *   registered format and has an id
 *
 * @remarks
 * A resource no descriptor's `isArchive` claims is dropped — the category
 * search returned it (the coding matched), but the format is not
 * registered here, so the shell has no reader for it. An archive with no
 * logical id is dropped too: a row exists to be selected, and a selection
 * needs an id to fetch by. The title and upload instant are read straight
 * off the attachment; neither decodes the bytes, so listing a page never
 * pulls a single archive's contents onto the device.
 */
const rowsOf = (
  entries: readonly { readonly resource: DocumentReferenceType | null }[]
): readonly ArchiveRow[] =>
  Arr.filterMap(entries, (entry): Option.Option<ArchiveRow> => {
    const resource = entry.resource
    if (resource === null || resource.id === null) return Option.none()
    const format = classifyArchive(resource)
    if (format === undefined) return Option.none()
    const attachment = resource.content[0]?.attachment
    return Option.some({
      id: resource.id,
      format,
      title: attachment?.title ?? null,
      creation: attachment?.creation ?? null,
    })
  })

/**
 * Query options for the paged archive read, for a caller that drives the
 * query itself (a route loader, a test through `QueryClient`).
 *
 * @param runAuthed - The authed runner from router context
 * @param options - Page size
 * @returns Infinite-query options whose pages are {@link ArchivePage}s
 *
 * @remarks
 * A bundle with no `next` link has no cursor, so `getNextPageParam` returns
 * `null` — which TanStack Query reads as "no further pages".
 */
const archivesInfiniteQueryOptions = (
  runAuthed: RunAuthed,
  options?: ArchivesQueryOptions
): UseInfiniteQueryOptions<
  ArchivePage,
  Error,
  InfiniteData<ArchivePage, ArchivePageParam>,
  ArchivesQueryKey,
  ArchivePageParam
> => {
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE
  return infiniteQueryOptions({
    queryKey: [...ARCHIVES_QUERY_KEY, { pageSize }] as const,
    initialPageParam: null as ArchivePageParam,
    getNextPageParam: (lastPage: ArchivePage): ArchivePageParam => lastPage.nextPageToken ?? null,
    queryFn: ({ pageParam }: { readonly pageParam: ArchivePageParam }): Promise<ArchivePage> =>
      runAuthed(
        Effect.gen(function* () {
          const client = yield* FhirR4ResourcesHttpApiClient
          const bundle = yield* client.DocumentReference.SearchByGet({
            urlParams: {
              category: ARCHIVES_CATEGORY_TOKEN,
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
 * Lists the device's uploaded archives across every registered format,
 * one page at a time. The authed runner comes from router context via
 * `fhir-r4-react`'s `useRunAuthed`.
 *
 * @param options - Page size
 * @returns The infinite query; `data.pages` are {@link ArchivePage}s in
 *   the order they were fetched
 */
const useArchivesQuery = (
  options?: ArchivesQueryOptions
): UseInfiniteQueryResult<InfiniteData<ArchivePage, ArchivePageParam>, Error> =>
  useInfiniteQuery(archivesInfiniteQueryOptions(useRunAuthed(), options))

/**
 * Fetches one archive whole and reads it back as a {@link PickedFile}.
 *
 * @param runAuthed - The authed runner from router context
 * @param row - The row a selection or preview identified — its id and its
 *   classified format
 * @returns The archive's raw bytes and a `server` source pointing back at it
 *
 * @remarks
 * Dispatches to the row's format's `archiveFromDocumentReference`, so a
 * resource that is not an archive of that format fails as a `ParseError`
 * rather than yielding nonsense. The bytes are carried verbatim — every
 * downstream step reads bytes (`decode`, and the confirm's upload if the
 * pick were local) — and the `server` source carries the archive's own
 * reference so a later step links provenance to the stored archive
 * instead of uploading the same bytes again.
 */
const fetchArchive = (
  runAuthed: RunAuthed,
  row: { readonly id: string; readonly format: FormatKind }
): Promise<PickedFile> =>
  runAuthed(
    Effect.gen(function* () {
      const client = yield* FhirR4ResourcesHttpApiClient
      const resource = yield* client.DocumentReference.GetById({ path: { id: row.id } })
      const archive = yield* formatRegistry[row.format].archiveFromDocumentReference(resource)
      return {
        fileName: archive.fileName,
        bytes: archive.bytes,
        source: serverSource(row.id),
      }
    })
  )

/**
 * Fetches the raw bytes and file name of one archive, without turning it
 * into a {@link PickedFile}. The read half of the preview modal.
 *
 * @param runAuthed - The authed runner from router context
 * @param row - The row a preview opened — its id and its classified format
 * @returns The archive's file name and raw bytes, or a rejection when the
 *   decoded resource is not this format's archive
 *
 * @remarks
 * Same underlying read as {@link fetchArchive}, without the source
 * synthesis: a preview does not pick, so it needs no `server` source. The
 * split is what lets the preview modal live at arm's length from the
 * source pipeline.
 */
const fetchArchiveContents = (
  runAuthed: RunAuthed,
  row: { readonly id: string; readonly format: FormatKind }
): Promise<{ readonly fileName: string; readonly bytes: Uint8Array }> =>
  runAuthed(
    Effect.gen(function* () {
      const client = yield* FhirR4ResourcesHttpApiClient
      const resource = yield* client.DocumentReference.GetById({ path: { id: row.id } })
      return yield* formatRegistry[row.format].archiveFromDocumentReference(resource)
    })
  )

export {
  ARCHIVES_CATEGORY_TOKEN,
  type ArchivePage,
  type ArchivePageParam,
  type ArchiveRow,
  archivesInfiniteQueryOptions,
  type ArchivesQueryKey,
  type ArchivesQueryOptions,
  DEFAULT_PAGE_SIZE,
  fetchArchive,
  fetchArchiveContents,
  useArchivesQuery,
}
