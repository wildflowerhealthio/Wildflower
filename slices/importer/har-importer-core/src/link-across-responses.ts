import { Array as Arr, Option } from 'effect'

import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'

import type { PreviewedOutcome, PreviewedResponse } from './review.ts'

/**
 * Where an archive import applies each source's `linkAcrossResponses`: over
 * the whole preview, once each source's `mergeResources` has run, and before
 * anything is reviewed or written.
 *
 * @packageDocumentation
 */

type Preview<K> = PreviewedResponse<K, DetachedResource.Type>

/** A preview that parsed to records. */
type ParsedPreview<K> = Preview<K> & {
  readonly outcome: Extract<PreviewedOutcome<DetachedResource.Type>, { readonly _tag: 'resources' }>
}

/** A source that gives a `linkAcrossResponses`. */
type LinkingSource = SourceDescriptor.SourceDescriptor<DetachedResource.Type> &
  Required<Pick<SourceDescriptor.SourceDescriptor<DetachedResource.Type>, 'linkAcrossResponses'>>

const givesLink = (
  source: SourceDescriptor.SourceDescriptor<DetachedResource.Type>
): source is LinkingSource => source.linkAcrossResponses !== undefined

/** Whether `preview` parsed to records through one of `source`'s kinds. */
const isParsedBy =
  (source: LinkingSource) =>
  <K>(preview: Preview<K>): preview is ParsedPreview<K> =>
    preview.outcome._tag === 'resources' &&
    Option.exists(preview.pickKindName, (kindName) =>
      source.responseKinds.some((kind) => kind.name === kindName)
    )

/** `preview`'s URL and records, as its source's link reads them. */
const responseRecordsOf = <K>(
  preview: ParsedPreview<K>
): SourceDescriptor.ResponseRecords<DetachedResource.Type> => ({
  url: preview.ref.url,
  records: preview.outcome.resources.map(({ resource }) => resource),
})

/** `preview` with `records` in its records' place, one for one, each under its review key. */
const withRecords = <K>(
  preview: ParsedPreview<K>,
  records: readonly DetachedResource.Type[]
): Preview<K> => ({
  ...preview,
  outcome: {
    ...preview.outcome,
    resources: Arr.zipWith(preview.outcome.resources, records, ({ key }, resource) => ({
      key,
      resource,
    })),
  },
})

/** The previews with `source`'s link applied to its own responses, every other preview as it was. */
const linkResponsesOf =
  (source: LinkingSource) =>
  <K>(previews: readonly Preview<K>[]): readonly Preview<K>[] => {
    const sourcePreviews = previews.filter(isParsedBy(source))
    const linked = source.linkAcrossResponses(sourcePreviews.map(responseRecordsOf))
    const linkedByPreview = new Map<Preview<K>, Preview<K>>(
      Arr.zipWith(sourcePreviews, linked, (preview, { records }) => [
        preview,
        withRecords(preview, records),
      ])
    )
    return previews.map((preview) => linkedByPreview.get(preview) ?? preview)
  }

/**
 * Apply each source's `linkAcrossResponses` to the previews its kinds parsed.
 *
 * @param sources - The registered sources; a response's pick is matched to its
 *   source by kind name
 * @param previews - Every response's preview, in archive order
 * @returns The same previews, in the same order, each keeping its review keys:
 *   a linking source's records as its link rewrote them, every other preview
 *   as it was. A link sees only its own source's responses.
 */
const linkAcrossSourceResponses = <K>(
  sources: readonly SourceDescriptor.SourceDescriptor<DetachedResource.Type>[],
  previews: readonly Preview<K>[]
): readonly Preview<K>[] =>
  sources.filter(givesLink).reduce((linked, source) => linkResponsesOf(source)(linked), previews)

export { linkAcrossSourceResponses }
