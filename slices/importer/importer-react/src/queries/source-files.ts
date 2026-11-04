import {
  infiniteQueryOptions,
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query'
import type { RunAuthed } from '@wildflowerhealthio/fhir-r4-react'
import {
  fetchDocumentReferencePage,
  type RunSmart,
  useRunSmart,
} from '@wildflowerhealthio/fhir-r4-react/smart'
import { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import type { DocumentReference } from '@wildflowerhealthio/fhir-r4/resources'
import { PickedFile } from '@wildflowerhealthio/importer-fundamentals'
import type { DateTime } from 'effect'
import { Array as Arr, Effect, Option, Schema } from 'effect'

import { formatKinds, type FormatKind } from '@wildflowerhealthio/importer-core'

import { formatRegistry } from '../registry.ts'
import { SOURCE_FILES_QUERY_KEY } from './keys.ts'

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
 * classified by dispatching every importer's `isSourceFile` predicate in
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
  .map((kind) => PickedFile.categoryToken(formatRegistry[kind].sourceFileFormat))
  .join(',')

/**
 * One source file as the list shows it: enough to name and date a row, its
 * id so a selection can fetch the whole source file and build its `server`
 * source, and the format tag the row was classified as so a preview or
 * pick dispatches to the right importer.
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
  /**
   * When the stored resource was last written, or `null` when it states no
   * instant.
   *
   * @remarks
   * The server's own `meta.lastUpdated`, not anything the source file carries: an
   * source file states what the file *is*, and the instant it reached the device is
   * the server's to know.
   */
  readonly lastUpdated: DateTime.Utc | null
  /**
   * The resource this source file is one source of — `context.related` — or
   * `null` when it names none.
   *
   * @remarks
   * What lets the list show a study's files as one study rather than N loose
   * rows. Only a group format writes it: a DICOM study's source files all name the
   * `ImagingStudy` they were read into, which is the only thing on the stored
   * resource that separates two studies of one patient (their `subject` is the
   * same `Patient`). A format whose files stand alone leaves it `null`.
   */
  readonly related: string | null
}

/** One page of source-file rows, plus the cursor for the next page. */
interface SourceFilePage {
  /** The source files on this page, in the order the server sent them. */
  readonly sourceFiles: readonly SourceFileRow[]
  /** The search bundle's `next`-link URL, or `null` at the end of the searchset. */
  readonly nextPageUrl: string | null
}

/**
 * The cursor paging carries: `null` for the first page, then the previous
 * page's `next`-link URL.
 */
type SourceFilePageParam = string | null

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
const classifySourceFile = (resource: DocumentReference.Type): FormatKind | undefined =>
  formatKinds.find((kind) =>
    PickedFile.isSourceFile(formatRegistry[kind].sourceFileFormat)(resource)
  )

/**
 * Projects decoded `DocumentReference` resources into source-file rows.
 *
 * @param resources - A search page's resources
 * @returns One {@link SourceFileRow} per resource that is a source file of a
 *   registered format and has an id
 *
 * @remarks
 * A resource no importer's `isSourceFile` claims is dropped — the category
 * search returned it (the coding matched), but the format is not
 * registered here, so the shell has no reader for it. A source file with no
 * logical id is dropped too: a row exists to be selected, and a selection
 * needs an id to fetch by. The title comes off the attachment and the date off
 * the resource's own `meta`; neither decodes the bytes, so listing a page never
 * pulls a single source file's contents onto the device.
 */
const rowsOf = (resources: readonly DocumentReference.Type[]): readonly SourceFileRow[] =>
  Arr.filterMap(resources, (resource): Option.Option<SourceFileRow> => {
    if (resource.id === null) return Option.none()
    const format = classifySourceFile(resource)
    if (format === undefined) return Option.none()
    const attachment = resource.content[0]?.attachment
    return Option.some({
      id: resource.id,
      format,
      title: attachment?.title ?? null,
      lastUpdated: resource.meta?.lastUpdated ?? null,
      related: resource.context?.related[0]?.reference ?? null,
    })
  })

/**
 * Query options for the paged source-file read, for a caller that drives the
 * query itself (a test through `QueryClient`).
 *
 * @param runSmart - The SMART runtime's runner the pages are read with
 * @returns Infinite-query options whose pages are {@link SourceFilePage}s
 *
 * @remarks
 * Each page is one `fetchDocumentReferencePage` over the SMART client: the
 * first searches every registered format's category, and each later one
 * follows the previous bundle's `next` link verbatim. A bundle with no `next`
 * link has no cursor, so `getNextPageParam` returns `null` — which TanStack
 * Query reads as "no further pages".
 */
const sourceFilesInfiniteQueryOptions = (
  runSmart: RunSmart
): UseInfiniteQueryOptions<
  SourceFilePage,
  Error,
  InfiniteData<SourceFilePage, SourceFilePageParam>,
  typeof SOURCE_FILES_QUERY_KEY,
  SourceFilePageParam
> =>
  infiniteQueryOptions({
    queryKey: SOURCE_FILES_QUERY_KEY,
    initialPageParam: null satisfies SourceFilePageParam,
    getNextPageParam: (lastPage: SourceFilePage): SourceFilePageParam => lastPage.nextPageUrl,
    queryFn: ({
      pageParam,
    }: {
      readonly pageParam: SourceFilePageParam
    }): Promise<SourceFilePage> =>
      runSmart(
        fetchDocumentReferencePage(
          pageParam === null
            ? { first: { patientId: null, category: SOURCE_FILES_CATEGORY_TOKEN } }
            : { pageUrl: pageParam }
        ).pipe(
          Effect.map((page) => ({ sourceFiles: rowsOf(page.items), nextPageUrl: page.nextPageUrl }))
        )
      ),
  })

/**
 * Lists the device's uploaded source files across every registered format,
 * one page at a time, over the SMART runtime the page's handshake built
 * (`useRunSmart`).
 *
 * @returns The infinite query; `data.pages` are {@link SourceFilePage}s in
 *   the order they were fetched
 */
const useSourceFilesQuery = (): UseInfiniteQueryResult<
  InfiniteData<SourceFilePage, SourceFilePageParam>,
  Error
> => useInfiniteQuery(sourceFilesInfiniteQueryOptions(useRunSmart()))

/**
 * Fetches one source file whole and reads it back as named bytes.
 *
 * @param runAuthed - The authed runner from router context
 * @param row - The row a selection or preview identified — its id and its
 *   classified format
 * @returns The stored file's own name and raw bytes
 *
 * @remarks
 * Decodes through `PickedFile.FromDocumentReference` under the row's format's
 * own constants, so a resource that is not a source file of that format fails as a
 * `ParseError` rather than yielding nonsense. The bytes are carried verbatim —
 * every downstream step reads bytes — and no id travels with them: a re-picked
 * source file mints the same id from the same bytes and name, so the row it
 * produces is the one already stored.
 *
 * One read for both consumers. The picker hands the result to the batch, which
 * gives it its batch id; the preview dialog renders it. A preview does not
 * pick, and there is nothing left for it to strip.
 */
const fetchSourceFile = (
  runAuthed: RunAuthed,
  row: { readonly id: string; readonly format: FormatKind }
): Promise<PickedFile.NamedBytes> =>
  runAuthed(
    Effect.gen(function* () {
      const client = yield* FhirR4ResourcesHttpApiClient
      const resource = yield* client.DocumentReference.GetById({ path: { id: row.id } })
      const { fileName, bytes } = yield* Schema.decode(PickedFile.FromDocumentReference)(
        resource
      ).pipe(Effect.provideService(PickedFile.Format, formatRegistry[row.format].sourceFileFormat))
      return { fileName, bytes }
    })
  )

export {
  fetchSourceFile,
  SOURCE_FILES_CATEGORY_TOKEN,
  type SourceFilePage,
  type SourceFilePageParam,
  type SourceFileRow,
  sourceFilesInfiniteQueryOptions,
  useSourceFilesQuery,
}
