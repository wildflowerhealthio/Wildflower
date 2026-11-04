import { Effect } from 'effect'

import { detach, type DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import {
  type HttpResponseKind,
  SourceDescriptor,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import {
  DecodedFileSet,
  DecodeFunction,
  type FileImporter,
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
import { defaultHarSettings, type HarSettings } from './har-settings.ts'
import { mergeSharedResources } from './merge-shared-resources.ts'
import { preview, type PreviewedResponse } from './review.ts'

type FhirPreview = PreviewedResponse<
  HttpResponseKind.HttpResponseKind<FhirResource>,
  DetachedResource.Type
>

const fhirPool = SourceDescriptor.poolOf(fhirSources)

const enabledKindNames = (settings: HarSettings): ReadonlySet<string> => {
  const disabled = new Set(settings.disabledKinds)
  return new Set(fhirPool.map((kind) => kind.name).filter((name) => !disabled.has(name)))
}

/**
 * The previews' records as one section per response URL, in the order each
 * URL first appears in the archive, each record titled by the reference it is
 * written under (`DecodedFileSet.writtenReferenceTitle`).
 */
const sectionsByUrl = (previews: readonly FhirPreview[]): readonly DecodedFileSet.Section[] => {
  const byUrl = new Map<string, DecodedFileSet.Entry[]>()
  for (const entry of previews) {
    if (entry.outcome._tag !== 'resources' || entry.outcome.resources.length === 0) continue
    const labeled = entry.outcome.resources.map(({ key, resource }): DecodedFileSet.Entry => ({
      key,
      title: DecodedFileSet.writtenReferenceTitle(resource, key),
      resource,
    }))
    const existing = byUrl.get(entry.ref.url)
    if (existing === undefined) byUrl.set(entry.ref.url, labeled)
    else existing.push(...labeled)
  }
  return Array.from(byUrl, ([url, entries]) => ({ title: url, entries }))
}

const notesFor = (previews: readonly FhirPreview[]): readonly string[] =>
  previews.flatMap((entry) => {
    const url = entry.ref.url
    const tag = entry.outcome._tag
    if (tag === 'resources') return []
    if (tag === 'duplicate') return [`Duplicate of an earlier response — not imported: ${url}`]
    if (tag === 'parseError') return [`Could not be parsed and will not import: ${url}`]
    if (tag === 'bodyAbsent') return [`The archive captured no response body: ${url}`]
    if (tag === 'noSystemFamily') {
      return [`Recognized, but its kind keys no records, so it will not import: ${url}`]
    }
    return entry.recognized.candidates.length === 0
      ? [`Matched no importer: ${url}`]
      : [`Excluded — every matching kind is turned off in the settings: ${url}`]
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
 * detached and folded into per-URL sections.
 *
 * @remarks
 * No `groupBy` — a HAR stands alone, so every pick is its own set — and no
 * `linkSourceFile`: a captured browsing session is an engineering artifact, so
 * its source file is stored exactly as minted rather than filed under a patient,
 * where it would land in `Patient/$everything`.
 */
const harImporter: FileImporter.Type<HarSettings, typeof format> = {
  format,
  display,
  detect: detectHar,
  defaultSettings: defaultHarSettings,
  sourceFileFormat,
  decode: DecodeFunction.make({
    format,
    decodeFileSet: (pickedFiles, settings) =>
      decodeHar(pickedFiles[0].bytes, settings).pipe(
        Effect.flatMap((responses) =>
          preview(fhirPool, responses, enabledKindNames(settings), detach)
        ),
        Effect.map((previews) => mergeSharedResources(fhirSources, previews)),
        Effect.map((previews) => ({
          sections: sectionsByUrl(previews),
          notes: notesFor(previews),
        }))
      ),
  }),
}

export { harImporter, fhirSources }
