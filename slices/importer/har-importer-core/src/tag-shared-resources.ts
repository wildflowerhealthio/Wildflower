import { Array as Arr, Function, Option } from 'effect'

import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'
import type { DecodedFile } from '@wildflowerhealthio/importer-fundamentals'

import type { PreviewedResource, PreviewedResponse } from './review.ts'

/**
 * Where an archive import finds the copies a source's `mergeResources`
 * merges: over the whole preview, once every response has parsed and been
 * detached. The merge itself runs after review, over the copies the reviewer
 * kept (`DecodedFile.mergeSharedCopies`), so leaving out one response leaves
 * out only its own copies.
 *
 * @packageDocumentation
 */

/**
 * The identity two records merge under: the archive, their source, then
 * their type and key, `(identifier[0].system, resourceType, identifier[0].value)`.
 * `None` for a keyless record, which is one of its own and never merges. The
 * archive is part of it so copies from two archives never merge, and the
 * source so one source's merge never sees another's record.
 */
const identityOf = (
  archiveId: string,
  sourceName: string,
  record: DetachedResource.Type
): Option.Option<string> =>
  Option.map(
    DetachedResource.keyOf(record),
    ({ system, value }) => `${archiveId} ${sourceName} ${record.resourceType} ${system}|${value}`
  )

/**
 * A source's merge of detached records, over the adopted rows a review
 * keeps: each copy handed over with its `id` cleared, as a detached record
 * has it, and the merge given the earlier copy's `id`.
 *
 * @remarks
 * A source's merge combines what its copies say; it never reads an `id`, so
 * the adopted copies' literal references pass through it as they are.
 */
const mergeOfAdopted =
  (merge: SourceDescriptor.ResourceMerge<DetachedResource.Type>): DecodedFile.Merge =>
  (earlier, later) => ({
    ...merge({ ...earlier, id: null }, { ...later, id: null }),
    id: earlier.id,
  })

/** A source that gives a `mergeResources`. */
type MergingSource = SourceDescriptor.SourceDescriptor<DetachedResource.Type> &
  Required<Pick<SourceDescriptor.SourceDescriptor<DetachedResource.Type>, 'mergeResources'>>

const givesMerge = (
  source: SourceDescriptor.SourceDescriptor<DetachedResource.Type>
): source is MergingSource => source.mergeResources !== undefined

/**
 * Tag the previewed records that share an identity as copies of it, for each
 * source that gives a `mergeResources`.
 *
 * @param sources - The registered sources; a response's pick is matched to its
 *   source by kind name
 * @param archiveId - The id of the archive's picked file, which scopes every
 *   identity to the archive
 * @param previews - Every response's preview, in archive order
 * @returns The same previews, every copy kept in its own response under its
 *   own key, each record whose identity occurs more than once tagged
 *   `shared`: the identity, and its source's merge over adopted rows. A
 *   source without a merge, and every keyless record, is left untagged.
 */
const tagSharedResources = (
  sources: readonly SourceDescriptor.SourceDescriptor<DetachedResource.Type>[],
  archiveId: string,
  previews: readonly PreviewedResponse<DetachedResource.Type>[]
): readonly PreviewedResponse<DetachedResource.Type>[] => {
  const mergingSourceByKindName = new Map(
    sources
      .filter(givesMerge)
      .flatMap((source) => source.responseKinds.map((kind) => [kind.name, source] as const))
  )
  const mergingSourceOf = (
    preview: PreviewedResponse<DetachedResource.Type>
  ): Option.Option<MergingSource> =>
    Option.flatMap(preview.pickKindName, (kindName) =>
      Option.fromNullable(mergingSourceByKindName.get(kindName))
    )
  /** The previews' merging-source records, each beside its source. */
  const sourcedResources = previews.flatMap((preview) => {
    const { outcome } = preview
    return outcome._tag === 'resources'
      ? Option.match(mergingSourceOf(preview), {
          onNone: () => [],
          onSome: (source) => outcome.resources.map((previewed) => ({ source, previewed })),
        })
      : []
  })
  const identityIn = (
    source: MergingSource,
    { resource }: PreviewedResource<DetachedResource.Type>
  ): Option.Option<string> => identityOf(archiveId, source.name, resource)
  const sharedIdentities = new Set(
    Object.entries(
      Arr.groupBy(
        sourcedResources.flatMap(({ source, previewed }) =>
          Option.toArray(identityIn(source, previewed))
        ),
        Function.identity
      )
    ).flatMap(([identity, copies]) => (copies.length > 1 ? [identity] : []))
  )

  /** `previewed`, tagged `shared` when its identity occurs more than once. */
  const tagged =
    (source: MergingSource) =>
    (
      previewed: PreviewedResource<DetachedResource.Type>
    ): PreviewedResource<DetachedResource.Type> =>
      Option.match(
        Option.filter(identityIn(source, previewed), (identity) => sharedIdentities.has(identity)),
        {
          onNone: () => previewed,
          onSome: (identity) => ({
            ...previewed,
            shared: { identity, merge: mergeOfAdopted(source.mergeResources) },
          }),
        }
      )

  return previews.map((preview) => {
    if (preview.outcome._tag !== 'resources') return preview
    const source = mergingSourceOf(preview)
    if (Option.isNone(source)) return preview
    return {
      ...preview,
      outcome: {
        ...preview.outcome,
        resources: preview.outcome.resources.map(tagged(source.value)),
      },
    }
  })
}

export { tagSharedResources }
