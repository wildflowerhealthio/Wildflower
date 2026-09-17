import { Effect } from 'effect'

import type { FhirResource } from 'fhir-r4/resources'
import { type HttpResponseKind, SourceDescriptor } from 'http-extraction-fundamentals'
import { FileImporter, type DecodedFile } from 'importer-fundamentals'

import {
  HAR_ARCHIVE_CODE,
  WEB_TRACE_CODE_SYSTEM,
  WEB_TRACE_RAW_CODE,
  WEB_TRACE_REDACTION_SYSTEM,
} from 'web-trace-core/codec'

import { decodeHar } from './decode-har.ts'
import { detectHar } from './detect-har.ts'
import { fhirSources } from './fhir-pool.ts'
import { defaultHarSettings, type HarSettings } from './har-settings.ts'
import { preview, type PreviewedResponse } from './review.ts'

type FhirPreview = PreviewedResponse<HttpResponseKind.HttpResponseKind<FhirResource>, FhirResource>

const fhirPool = SourceDescriptor.poolOf(fhirSources)

const enabledKindNames = (settings: HarSettings): ReadonlySet<string> => {
  const disabled = new Set(settings.disabledKinds)
  return new Set(fhirPool.map((kind) => kind.name).filter((name) => !disabled.has(name)))
}

const sectionsByUrl = (
  previews: readonly FhirPreview[]
): readonly DecodedFile.Section<FhirResource>[] => {
  const order: string[] = []
  const byUrl = new Map<string, DecodedFile.Resource<FhirResource>[]>()
  for (const entry of previews) {
    if (entry.outcome._tag !== 'resources' || entry.outcome.resources.length === 0) continue
    const url = entry.ref.url
    const labeled = entry.outcome.resources.map((resource): DecodedFile.Resource<FhirResource> => ({
      key: resource.key,
      title: `${resource.resource.resourceType}/${resource.resource.id ?? '?'}`,
      resource: resource.resource,
    }))
    const existing = byUrl.get(url)
    if (existing === undefined) {
      order.push(url)
      byUrl.set(url, [...labeled])
    } else existing.push(...labeled)
  }
  return order.map((url) => ({ title: url, resources: byUrl.get(url) ?? [] }))
}

const notesFor = (previews: readonly FhirPreview[]): readonly string[] =>
  previews.flatMap((entry) => {
    const url = entry.ref.url
    const tag = entry.outcome._tag
    if (tag === 'resources') return []
    if (tag === 'duplicate') return [`Duplicate of an earlier response — not imported: ${url}`]
    if (tag === 'parseError') return [`Could not be parsed and will not import: ${url}`]
    if (tag === 'bodyAbsent') return [`The archive captured no response body: ${url}`]
    return entry.recognized.candidates.length === 0
      ? [`Matched no importer: ${url}`]
      : [`Excluded — every matching kind is turned off in the settings: ${url}`]
  })

const harImporter = new FileImporter({
  format: 'har',
  coding: { system: WEB_TRACE_CODE_SYSTEM, code: HAR_ARCHIVE_CODE },
  contentType: 'application/json',
  securityLabel: [{ system: WEB_TRACE_REDACTION_SYSTEM, code: WEB_TRACE_RAW_CODE }],
  display: {
    title: 'HAR archive',
    description: 'Import FHIR records from a captured browsing session.',
  },
  detect: detectHar,
  defaultSettings: defaultHarSettings,
  decodeOne: (file, settings) =>
    decodeHar(file.bytes, settings).pipe(
      Effect.flatMap((responses) => preview(fhirPool, responses, enabledKindNames(settings))),
      Effect.map((previews): DecodedFile.DecodedFile<FhirResource> => ({
        sections: sectionsByUrl(previews),
        notes: notesFor(previews),
      }))
    ),
})

export { harImporter, fhirSources }
export { HAR_ARCHIVE_CODE, WEB_TRACE_CODE_SYSTEM } from 'web-trace-core/codec'
