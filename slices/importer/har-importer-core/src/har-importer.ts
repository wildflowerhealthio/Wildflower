import { Effect } from 'effect'

import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'
import {
  type DecodedFileSet,
  DecodeFunction,
  type FileImporter,
  Sectioned,
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
 * The previews' records as one section per response URL, in the order each
 * URL first appears in the archive, each record's `fullUrl` its preview key
 * (`<response id>:<index>`).
 */
const sectionsByUrl = (previews: readonly FhirPreview[]): Sectioned.Type<DecodedFileSet.Entry> =>
  Sectioned.map(
    Sectioned.groupBy(
      previews.flatMap(({ ref, outcome }) =>
        outcome._tag === 'resources'
          ? outcome.resources.map(({ key, resource }) => ({
              url: ref.url,
              entry: { fullUrl: key, resource },
            }))
          : []
      ),
      ({ url }) => url
    ),
    ({ entry }) => entry
  )

const notesFor = (previews: readonly FhirPreview[]): readonly string[] =>
  previews.flatMap((entry) => {
    const url = entry.ref.url
    const tag = entry.outcome._tag
    if (tag === 'resources') return []
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
        Effect.map((previews) => ({
          ...sectionsByUrl(previews),
          notes: notesFor(previews),
        }))
      ),
  }),
}

export { harImporter }
