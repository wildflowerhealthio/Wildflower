import { Effect, Option, pipe } from 'effect'

import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import {
  type HttpResponseKind,
  SourceDescriptor,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import {
  type DecodedFileSet,
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
  HttpResponseKind.HttpResponseKind<DetachedResource.Type>,
  DetachedResource.Type
>

const fhirPool = SourceDescriptor.poolOf(fhirSources)

const enabledKindNames = (settings: HarSettings): ReadonlySet<string> => {
  const disabled = new Set(settings.disabledKinds)
  return new Set(fhirPool.map((kind) => kind.name).filter((name) => !disabled.has(name)))
}

/** The tail of a FHIR server's `Binary` read path: `/Binary/<id>`, the id in R4's id grammar. */
const BINARY_READ_PATH = /\/Binary\/[A-Za-z0-9\-.]{1,64}$/

/**
 * The URL a `Binary` read served at `responseUrl` names the Binary by: the
 * read's URL less its query and fragment, `<root>/Binary/<id>`. `None` for a
 * response that is no `Binary` read.
 */
const binaryUrlIfRead = (responseUrl: string): Option.Option<string> =>
  pipe(
    Option.fromNullable(URL.parse(responseUrl)),
    Option.filter(({ pathname }) => BINARY_READ_PATH.test(pathname)),
    Option.map(({ origin, pathname }) => `${origin}${pathname}`)
  )

/**
 * A previewed record's `fullUrl`: for a `Binary` a read served, the server's
 * URL for it ({@link binaryUrlIfRead}); for any other record, its preview
 * key, `<response id>:<index>`.
 *
 * @remarks
 * A Binary has no identifier, so its `fullUrl` is what names it: a reference
 * or an `Attachment.url` naming it is detached to the same URL, and the import
 * stage resolves one to the other.
 */
const fullUrlOf = (responseUrl: string, key: string, resource: DetachedResource.Type): string =>
  resource.resourceType === 'Binary'
    ? Option.getOrElse(binaryUrlIfRead(responseUrl), () => key)
    : key

/**
 * The previews' records as one section per response URL, in the order each
 * URL first appears in the archive, each record's `fullUrl` from
 * {@link fullUrlOf}.
 *
 * @remarks
 * Only the first record per `fullUrl` is kept, so a Binary served by two
 * reads (one with a query string, one without) is one record; a section left
 * with no record is dropped.
 */
const sectionsByUrl = (previews: readonly FhirPreview[]): readonly DecodedFileSet.Section[] => {
  const byUrl = new Map<string, DecodedFileSet.Entry[]>()
  const seenFullUrls = new Set<string>()
  const isFirstOfItsFullUrl = ({ fullUrl }: DecodedFileSet.Entry): boolean => {
    if (seenFullUrls.has(fullUrl)) return false
    seenFullUrls.add(fullUrl)
    return true
  }
  for (const entry of previews) {
    if (entry.outcome._tag !== 'resources') continue
    const labeled = entry.outcome.resources
      .map(({ key, resource }): DecodedFileSet.Entry => ({
        fullUrl: fullUrlOf(entry.ref.url, key, resource),
        resource,
      }))
      .filter(isFirstOfItsFullUrl)
    if (labeled.length === 0) continue
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
 * folded into per-URL sections.
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
        Effect.flatMap((responses) => preview(fhirPool, responses, enabledKindNames(settings))),
        Effect.map((previews) => mergeSharedResources(fhirSources, previews)),
        Effect.map((previews) => ({
          sections: sectionsByUrl(previews),
          notes: notesFor(previews),
        }))
      ),
  }),
}

export { harImporter, fhirSources }
