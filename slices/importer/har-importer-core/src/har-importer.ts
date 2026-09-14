import { Effect } from 'effect'

import type { FhirResource } from 'fhir-r4/resources'
import { type HttpResponseKind, SourceDescriptor } from 'http-extraction-fundamentals'
import type {
  DecodedFile,
  FileImporterDescriptor,
  LabeledResource,
  LabeledSection,
} from 'importer-fundamentals'

import {
  HAR_ARCHIVE_CATEGORY_TOKEN,
  HAR_ARCHIVE_CONTENT_TYPE,
  harArchiveFromDocumentReference,
  isHarArchive,
  sourceArchive,
} from './archive/index.ts'
import { decodeHar } from './decode-har.ts'
import { detectHar } from './detect-har.ts'
import { fhirSources } from './fhir-pool.ts'
import { defaultHarSettings, type HarSettings } from './har-settings.ts'
import { preview, type PreviewedResponse } from './review.ts'

/** One previewed response at the concrete FHIR binding. */
type FhirPreview = PreviewedResponse<HttpResponseKind.HttpResponseKind<FhirResource>, FhirResource>

/** The flat pool derived once from the sources — what recognition routes against. */
const fhirPool = SourceDescriptor.poolOf(fhirSources)

/** The kind names the settings leave enabled, out of the whole pool. */
const enabledKindNames = (settings: HarSettings): ReadonlySet<string> => {
  const disabled = new Set(settings.disabledKinds)
  return new Set(fhirPool.map((kind) => kind.name).filter((name) => !disabled.has(name)))
}

/**
 * The previews folded into per-URL sections, in first-seen URL order. Only a
 * response that parsed to at least one resource contributes; everything else
 * becomes a note via {@link notesFor}.
 */
const sectionsByUrl = (
  previews: readonly FhirPreview[]
): readonly LabeledSection<FhirResource>[] => {
  const order: string[] = []
  const byUrl = new Map<string, LabeledResource<FhirResource>[]>()
  for (const entry of previews) {
    if (entry.outcome._tag !== 'resources' || entry.outcome.resources.length === 0) continue
    const url = entry.ref.url
    const labeled = entry.outcome.resources.map((resource): LabeledResource<FhirResource> => ({
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

/**
 * The file-level diagnostic notes: one line per response that yielded no
 * resources, in input order, each naming its URL — what the collapsed
 * per-response states of the old interactive review said, folded to data.
 */
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

/**
 * The concrete {@link FileImporterDescriptor} for the `har` format: HAR decode
 * in, FHIR resources out, written through the FHIR store.
 *
 * @remarks
 * `decode` runs the whole read half: the HAR parse, per-URL recognition
 * against the pool (filtered by the settings' kind toggles), and the parse of
 * every chosen response — folded into per-URL {@link LabeledSection}s plus a
 * note per response that yielded nothing. Resource keys are
 * `responseId:index`, independent of the kind toggles, so a settings change
 * re-decodes to the same keys for the resources that survive it.
 */
const harImporterDescriptor: FileImporterDescriptor<HarSettings, FhirResource> = {
  format: 'har',
  display: {
    title: 'HAR archive',
    description: 'Import FHIR records from a captured browsing session.',
  },
  accept: ['.har', 'application/json'],
  detect: detectHar,
  defaultSettings: defaultHarSettings,
  decode: (fileBytes, settings) =>
    decodeHar(fileBytes, settings).pipe(
      Effect.flatMap((responses) => preview(fhirPool, responses, enabledKindNames(settings))),
      Effect.map((previews): DecodedFile<FhirResource> => ({
        sections: sectionsByUrl(previews),
        notes: notesFor(previews),
      }))
    ),
  sourceArchive,
  archiveCategoryToken: HAR_ARCHIVE_CATEGORY_TOKEN,
  isArchive: isHarArchive,
  archiveFromDocumentReference: (resource) =>
    harArchiveFromDocumentReference(resource).pipe(
      Effect.map((archive) => ({ fileName: archive.fileName, bytes: archive.bytes }))
    ),
  archiveContentType: HAR_ARCHIVE_CONTENT_TYPE,
}

export { harImporterDescriptor }
