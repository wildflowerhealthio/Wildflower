import { Array as Arr, Effect, Either, Option } from 'effect'

import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { type Extraction, SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'
import {
  DecodedFileSet,
  DecodeFunction,
  type FileImporter,
  type FileSetRecord,
  SectionedList,
} from '@wildflowerhealthio/importer-fundamentals'

import {
  HAR_ARCHIVE_CODE,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
} from '@wildflowerhealthio/web-trace-core/codec'

import { decodeHar } from './decode-har.ts'
import { detectHar } from './detect-har.ts'
import { fhirSources } from './fhir-pool.ts'
import { mergeSharedResources } from './merge-shared-resources.ts'
import { preview, type PreviewedResponse } from './review.ts'

type FhirPreview = PreviewedResponse<DetachedResource.Type>

const fhirPool = SourceDescriptor.poolOf(fhirSources)

/**
 * The URL a record a response at `responseUrl` held was served at, when
 * nothing else names it: for a `Binary` a read served, the server's URL for
 * it (`DetachedResource.serverBinaryUrlIfRead`); `None` for any other record.
 *
 * @remarks
 * A Binary has no identifier, so this URL is what names it: a reference or an
 * `Attachment.url` naming it is detached to the same URL, and the import
 * stage resolves one to the other.
 */
const sourceUrlOf = (responseUrl: string, resource: DetachedResource.Type): Option.Option<URL> =>
  resource.resourceType === 'Binary'
    ? DetachedResource.serverBinaryUrlIfRead(responseUrl)
    : Option.none()

/**
 * The previews with every record whose source URL ({@link sourceUrlOf}) an
 * earlier record already has left out, and a response left with no record a
 * `duplicate` of the response that first held it.
 *
 * @remarks
 * So a Binary served by two reads (one with a query string, one without) is
 * one record, and the second read is noted as a duplicate, as a response
 * repeated byte for byte is. Only a Binary has a source URL, so only a
 * Binary repeats.
 */
const withRepeatedRecordsAsDuplicates = (
  previews: readonly FhirPreview[]
): readonly FhirPreview[] => {
  const firstHolders = new Map<string, Extraction.ResponseRef>()
  return previews.map((response): FhirPreview => {
    const { outcome, ref } = response
    if (outcome._tag !== 'resources') return response
    // Each record kept, or the response that first held its source URL.
    const [kept, holdersOfRepeats] = Arr.partitionMap(outcome.resources, (record) =>
      Option.match(sourceUrlOf(ref.url, record.resource), {
        onNone: () => Either.left(record),
        onSome: ({ href }) => {
          const holder = firstHolders.get(href)
          if (holder !== undefined) return Either.right(holder)
          firstHolders.set(href, ref)
          return Either.left(record)
        },
      })
    )
    return Arr.match(holdersOfRepeats, {
      onEmpty: () => response,
      onNonEmpty: ([firstHolder]) => ({
        ...response,
        outcome:
          kept.length === 0
            ? { _tag: 'duplicate', of: firstHolder }
            : { _tag: 'resources', resources: kept },
      }),
    })
  })
}

/**
 * The previews' records as one section per response URL, in the order each
 * URL first appears in the archive, each record's local key its preview key
 * (`<response id>:<index>`) and its source URL from {@link sourceUrlOf}.
 */
const sectionsByUrl = (previews: readonly FhirPreview[]): SectionedList.Type<FileSetRecord.Type> =>
  SectionedList.map(
    SectionedList.groupBy(
      previews.flatMap(({ ref, outcome }) =>
        outcome._tag === 'resources'
          ? outcome.resources.map(({ key, resource }) => ({
              url: ref.url,
              record: { localKey: key, resource, sourceUrl: sourceUrlOf(ref.url, resource) },
            }))
          : []
      ),
      ({ url }) => url
    ),
    ({ record }) => record
  )

const notesFor = (previews: readonly FhirPreview[]): readonly string[] =>
  previews.flatMap((entry) => {
    const url = entry.ref.url
    const tag = entry.outcome._tag
    if (tag === 'resources') {
      // A Binary read that parsed to nothing was served as its raw content.
      return entry.outcome.resources.length === 0 &&
        Option.isSome(DetachedResource.serverBinaryUrlIfRead(url))
        ? [`A Binary served as its raw content, not as FHIR JSON — not imported: ${url}`]
        : []
    }
    if (tag === 'duplicate') return [`Duplicate of an earlier response — not imported: ${url}`]
    if (tag === 'parseError') return [`Could not be parsed and will not import: ${url}`]
    if (tag === 'bodyAbsent') return [`The archive captured no response body: ${url}`]
    return [`Matched no importer: ${url}`]
  })
const format = 'har'

const display = {
  title: 'HAR archive',
  description: 'Import FHIR records from a captured browsing session.',
}

const sourceFileFormat = {
  coding: { system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE },
  contentType: 'application/json',
  securityLabel: [{ system: WEB_TRACE_REDACTION_SYSTEM, code: WEB_TRACE_RAW_CODE }],
  descriptionPrefix: `${display.title}: `,
}

/**
 * The HAR importer: one source file per pick, its recognized responses
 * folded into per-URL sections.
 *
 * @remarks
 * No settings: every response routes to its top-ranked kind, so the format's
 * settings are `null` and the shell shows no settings form for it. No `groupBy`
 * — a HAR stands alone, so every pick is its own set — and no `linkSourceFile`:
 * a captured browsing session is an engineering artifact, so its source file is
 * stored exactly as minted rather than filed under a patient, where it would
 * land in `Patient/$everything`.
 */
const harImporter: FileImporter.Type<null, typeof format> = {
  format,
  display,
  detect: detectHar,
  defaultSettings: null,
  sourceFileFormat,
  decode: DecodeFunction.make({
    format,
    decodeFileSet: (pickedFiles) =>
      decodeHar(pickedFiles[0].bytes).pipe(
        Effect.flatMap((responses) => preview(fhirPool, responses)),
        Effect.map((previews) => mergeSharedResources(fhirSources, previews)),
        Effect.map(withRepeatedRecordsAsDuplicates),
        Effect.map((previews) => ({
          pickedFiles: Arr.map(pickedFiles, DecodedFileSet.unidentified),
          sectionedList: sectionsByUrl(previews),
          notes: notesFor(previews),
        }))
      ),
  }),
}

export { harImporter }
