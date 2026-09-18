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
import { fetchDocumentReferencePage, useSmartHandshake } from 'fhir-r4-react/smart'
import { FhirR4ResourcesHttpApiClient } from 'fhir-r4/clients'
import { type DocumentReferenceType, PickedFile } from 'importer-fundamentals'

type SmartClient = Parameters<typeof fetchDocumentReferencePage>[0]

import { formatKinds, formatRegistry, type FormatKind } from '../registry.ts'
import { SOURCE_FILES_QUERY_KEY } from './keys.ts'
import { nextPageToken } from './page-token.ts'

/**
 * The paged read behind the server source: uploaded source-file
 * `DocumentReference`s off the device's own FHIR server, across every
 * registered format, listed as rows and fetched whole only when one is
 * selected.
 *
 * @remarks
 * One search per page over every registered format's source-file category
 * token, joined with FHIR's comma-OR (`category=t1,t2`), so the whole
 * cross-format listing is one round trip per page. Each returned resource is
 * classified by dispatching every descriptor's `isSourceFile` predicate in
 * registry order; predicates are disjoint by construction (HAR under
 * `WEB_TRACE_CODE_SYSTEM`, LifeLabs under `LIFELABS_SYSTEM`) so at most one
 * claims any row, and a row no predicate claims (the coding matched the
 * search but is from an unregistered format) is dropped.
 *
 * The list holds only what a row shows (title, upload instant, format tag);
 * a source file's bytes are large and are fetched one at a time, by
 * {@link fetchSourceFile}, when the user picks a row or opens its preview.
 * Source-file categories are disjoint from the web-trace trace category on
 * the same axis, so this list never returns a trace and the web-trace
 * viewer's list never returns a source file.
 *
 * @packageDocumentation
 */

/**
 * How many source-file `DocumentReference`s one page requests.
 *
 * @remarks
 * A page is one round trip. Large enough that a device holding a handful of
 * uploaded source files lists them in one page, small enough that a long
 * history paints its first rows without waiting on the rest.
 */
const DEFAULT_PAGE_SIZE = 50

/**
 * The comma-joined `system|code` search value covering every registered
 * format's source-file category token — the one value the server-side search
 * filters on.
 *
 * @remarks
 * Built once at module load from `formatRegistry`, in registry order, so
 * the shape stays a single source of truth (add a format to the registry,
 * its token joins this string). FHIR's search grammar is "AND across
 * parameters, OR within a comma-joined value", so this asks for a
 * `DocumentReference` matching *any* of the tokens.
 */
const SOURCE_FILES_CATEGORY_TOKEN = formatKinds
  .map((kind) => formatRegistry[kind].categoryToken)
  .join(',')

/**
 * One source file as the list shows it: enough to name and date a row, its
 * id so a selection can fetch the whole source file and build its `server`
 * source, and the format tag the row was classified as so a preview or
 * pick dispatches to the right descriptor.
 *
 * @remarks
 * Deliberately not the source file itself. The bytes are the file,
 * potentially many megabytes; listing them all to render a title would pull
 * every source file onto the device to show a list. The row carries the id
 * and the format; {@link fetchSourceFile} reads the one the user chose.
 */
interface SourceFileRow {
  /** The source-file `DocumentReference`'s logical id. */
  readonly id: string
  /**
   * Which registered format this source file is, by the `isSourceFile`
   * predicate that claimed it. Drives the preview modal's renderer choice
   * and the fetch's decoder.
   */
  readonly format: FormatKind
  /** The source file's title — its original file name — or `null` when it carries none. */
  readonly title: string | null
  /** When the source file was uploaded, or `null` when the resource states no instant. */
  readonly creation: DateTime.Utc | null
}

/** One page of source-file rows, plus the cursor for the next page. */
interface SourceFilePage {
  /** The source files on this page, in the order the server sent them. */
  readonly sourceFiles: readonly SourceFileRow[]
  /** The cursor for the following page, or `undefined` at the end of the searchset. */
  readonly nextPageToken: string | undefined
}

/** The cursor type paging carries; `null` is the first page, not a page named null. */
type SourceFilePageParam = string | null

/** Query key for the paged read, distinguished by page size. */
type SourceFilesQueryKey = readonly [
  ...typeof SOURCE_FILES_QUERY_KEY,
  { readonly pageSize: number },
]

/** Options for {@link sourceFilesInfiniteQueryOptions} and {@link useSourceFilesQuery}. */
interface SourceFilesQueryOptions {
  /**
   * How many resources to request per page.
   *
   * @defaultValue 50
   */
  readonly pageSize?: number
}

/**
 * The first registered format whose `isSourceFile` claims the resource, or
 * `undefined` when none does.
 *
 * @remarks
 * Predicates are disjoint by construction (each tests a different
 * `system|code` on the `category` axis), so first-match is the only match.
 * Iteration is in registry order — the format-kind literal walk, not the
 * `Object.keys(formatRegistry)` order — so the classification is
 * deterministic across engines.
 */
const classifySourceFile = (resource: DocumentReferenceType): FormatKind | undefined =>
  formatKinds.find((kind) => formatRegistry[kind].isSourceFile(resource))

/**
 * Projects a searchset bundle's entries into source-file rows.
 *
 * @param entries - The bundle's entries, whose `resource` may be absent
 * @returns One {@link SourceFileRow} per entry that is a source file of a
 *   registered format and has an id
 *
 * @remarks
 * A resource no descriptor's `isSourceFile` claims is dropped — the category
 * search returned it (the coding matched), but the format is not
 * registered here, so the shell has no reader for it. A source file with no
 * logical id is dropped too: a row exists to be selected, and a selection
 * needs an id to fetch by. The title and upload instant are read straight
 * off the attachment; neither decodes the bytes, so listing a page never
 * pulls a single source file's contents onto the device.
 */
const rowsOf = (
  entries: readonly { readonly resource: DocumentReferenceType | null }[]
): readonly SourceFileRow[] =>
  Arr.filterMap(entries, (entry): Option.Option<SourceFileRow> => {
    const resource = entry.resource
    if (resource === null || resource.id === null) return Option.none()
    const format = classifySourceFile(resource)
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
 * Projects decoded `DocumentReference` resources (as returned by
 * {@link fetchDocumentReferencePage}) into source-file rows.
 */
const rowsFromResources = (resources: readonly DocumentReferenceType[]): readonly SourceFileRow[] =>
  rowsOf(resources.map((resource) => ({ resource })))

/**
 * Query options for the paged source-file read, for a caller that drives the
 * query itself (a route loader, a test through `QueryClient`).
 *
 * @param runAuthed - The authed runner from router context
 * @param options - Page size
 * @returns Infinite-query options whose pages are {@link SourceFilePage}s
 *
 * @remarks
 * A bundle with no `next` link has no cursor, so `getNextPageParam` returns
 * `null` — which TanStack Query reads as "no further pages".
 */
const sourceFilesInfiniteQueryOptions = (
  runAuthed: RunAuthed,
  options?: SourceFilesQueryOptions
): UseInfiniteQueryOptions<
  SourceFilePage,
  Error,
  InfiniteData<SourceFilePage, SourceFilePageParam>,
  SourceFilesQueryKey,
  SourceFilePageParam
> => {
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE
  return infiniteQueryOptions({
    queryKey: [...SOURCE_FILES_QUERY_KEY, { pageSize }] as const,
    initialPageParam: null satisfies SourceFilePageParam,
    getNextPageParam: (lastPage: SourceFilePage): SourceFilePageParam =>
      lastPage.nextPageToken ?? null,
    queryFn: ({
      pageParam,
    }: {
      readonly pageParam: SourceFilePageParam
    }): Promise<SourceFilePage> =>
      runAuthed(
        Effect.gen(function* () {
          const client = yield* FhirR4ResourcesHttpApiClient
          const bundle = yield* client.DocumentReference.SearchByGet({
            urlParams: {
              category: SOURCE_FILES_CATEGORY_TOKEN,
              _count: pageSize,
              ...(pageParam === null ? {} : { _pageToken: pageParam }),
            },
          })
          return {
            sourceFiles: rowsOf(bundle.entry),
            nextPageToken: nextPageToken(bundle.link),
          }
        })
      ),
  })
}

/**
 * Lists the device's uploaded source files across every registered format,
 * one page at a time. The authed runner comes from router context via
 * `fhir-r4-react`'s `useRunAuthed`.
 *
 * @param options - Page size
 * @returns The infinite query; `data.pages` are {@link SourceFilePage}s in
 *   the order they were fetched
 */
const useSourceFilesQuery = (
  options?: SourceFilesQueryOptions
): UseInfiniteQueryResult<InfiniteData<SourceFilePage, SourceFilePageParam>, Error> =>
  useInfiniteQuery(sourceFilesInfiniteQueryOptions(useRunAuthed(), options))

/**
 * Query options for the source-file listing that pages through
 * {@link fetchDocumentReferencePage} via the SMART fhirclient `Client`, rather
 * than the typed Effect client.
 *
 * @param smartClient - The fhirclient `Client` from a completed SMART handshake
 * @param options - Page size (default {@link DEFAULT_PAGE_SIZE})
 * @returns Infinite-query options whose pages are {@link SourceFilePage}s
 *
 * @remarks
 * The paging cursor is the full `next`-link URL from the bundle (not the
 * extracted `_pageToken` the typed-client variant uses), passed verbatim on the
 * next request — the same mechanism every SMART reader in `fhir-r4-react/smart`
 * uses.
 */
const smartSourceFilesInfiniteQueryOptions = (
  smartClient: SmartClient,
  options?: SourceFilesQueryOptions
): UseInfiniteQueryOptions<
  SourceFilePage,
  Error,
  InfiniteData<SourceFilePage, SourceFilePageParam>,
  SourceFilesQueryKey,
  SourceFilePageParam
> => {
  const pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE
  return infiniteQueryOptions({
    queryKey: [...SOURCE_FILES_QUERY_KEY, { pageSize }] as const,
    initialPageParam: null satisfies SourceFilePageParam,
    getNextPageParam: (lastPage: SourceFilePage): SourceFilePageParam =>
      lastPage.nextPageToken ?? null,
    queryFn: ({
      pageParam,
    }: {
      readonly pageParam: SourceFilePageParam
    }): Promise<SourceFilePage> =>
      Effect.runPromise(
        fetchDocumentReferencePage(
          smartClient,
          pageParam === null
            ? {
                first: {
                  patientId: null,
                  category: SOURCE_FILES_CATEGORY_TOKEN,
                },
              }
            : { pageUrl: pageParam }
        )
      ).then((page) => ({
        sourceFiles: rowsFromResources(page.items),
        nextPageToken: page.nextPageUrl ?? undefined,
      })),
  })
}

/**
 * Lists the device's uploaded source files using the SMART fhirclient
 * transport. The SMART client comes from `useSmartHandshake`; if the
 * handshake has not completed yet the query is disabled.
 *
 * @param options - Page size
 * @returns The infinite query; `data.pages` are {@link SourceFilePage}s in
 *   the order they were fetched
 */
const useSmartSourceFilesQuery = (
  options?: SourceFilesQueryOptions
): UseInfiniteQueryResult<InfiniteData<SourceFilePage, SourceFilePageParam>, Error> => {
  const handshake = useSmartHandshake()
  const client = handshake.kind === 'ready' ? handshake.client : undefined
  // When the SMART client is not yet available, fall back to the typed-client
  // variant so the query still works (e.g. when the handshake is in progress
  // and the component mounts during the connection phase).
  const runAuthed = useRunAuthed()
  return useInfiniteQuery(
    client !== undefined
      ? smartSourceFilesInfiniteQueryOptions(client, options)
      : sourceFilesInfiniteQueryOptions(runAuthed, options)
  )
}

/**
 * Fetches one source file whole and reads it back as a {@link PickedFile}.
 *
 * @param runAuthed - The authed runner from router context
 * @param row - The row a selection or preview identified — its id and its
 *   classified format
 * @returns The source file's raw bytes and a `server` source pointing back at it
 *
 * @remarks
 * Dispatches to the row's format's `sourceFileFromDocumentReference`, so a
 * resource that is not a source file of that format fails as a `ParseError`
 * rather than yielding nonsense. The bytes are carried verbatim — every
 * downstream step reads bytes (`decode`, and the confirm's upload if the
 * pick were local) — and the `server` source carries the source file's own
 * reference so a later step links provenance to the stored source file
 * instead of uploading the same bytes again.
 */
const fetchSourceFile = (
  runAuthed: RunAuthed,
  row: { readonly id: string; readonly format: FormatKind }
): Promise<PickedFile.Type> =>
  runAuthed(
    Effect.gen(function* () {
      const client = yield* FhirR4ResourcesHttpApiClient
      const resource = yield* client.DocumentReference.GetById({ path: { id: row.id } })
      const { fileName, bytes } =
        yield* formatRegistry[row.format].sourceFileFromDocumentReference(resource)
      return {
        fileName,
        bytes,
        source: PickedFile.Source.server(row.id),
      }
    })
  )

/**
 * Fetches the raw bytes and file name of one source file, without turning it
 * into a {@link PickedFile}. The read half of the preview modal.
 *
 * @param runAuthed - The authed runner from router context
 * @param row - The row a preview opened — its id and its classified format
 * @returns The source file's file name and raw bytes, or a rejection when the
 *   decoded resource is not this format's source file
 *
 * @remarks
 * Same underlying read as {@link fetchSourceFile}, without the source
 * synthesis: a preview does not pick, so it needs no `server` source. The
 * split is what lets the preview modal live at arm's length from the
 * source pipeline.
 */
const fetchSourceFileContents = (
  runAuthed: RunAuthed,
  row: { readonly id: string; readonly format: FormatKind }
): Promise<PickedFile.NamedBytes> =>
  runAuthed(
    Effect.gen(function* () {
      const client = yield* FhirR4ResourcesHttpApiClient
      const resource = yield* client.DocumentReference.GetById({ path: { id: row.id } })
      const { fileName, bytes } =
        yield* formatRegistry[row.format].sourceFileFromDocumentReference(resource)
      return { fileName, bytes }
    })
  )

export {
  DEFAULT_PAGE_SIZE,
  fetchSourceFile,
  fetchSourceFileContents,
  SOURCE_FILES_CATEGORY_TOKEN,
  type SourceFilePage,
  type SourceFilePageParam,
  type SourceFileRow,
  smartSourceFilesInfiniteQueryOptions,
  sourceFilesInfiniteQueryOptions,
  type SourceFilesQueryKey,
  type SourceFilesQueryOptions,
  useSmartSourceFilesQuery,
  useSourceFilesQuery,
}
