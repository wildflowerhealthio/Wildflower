import { Option } from 'effect'

import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import type { SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'

import type { PreviewedResource, PreviewedResponse } from './review.ts'

/**
 * Where an archive import applies each source's `mergeResources`: over the
 * whole preview, once every response has parsed and been detached, and before
 * anything is reviewed or written.
 *
 * @packageDocumentation
 */

/**
 * The key two records merge under: their source, then their type and key,
 * `(identifier[0].system, resourceType, identifier[0].value)`. `None` for a
 * keyless record, which is one of its own and never merges. The source is part
 * of it so one source's merge never sees another's record.
 */
const identityOf = (sourceName: string, record: DetachedResource.Type): Option.Option<string> =>
  Option.map(
    DetachedResource.keyOf(record),
    ({ system, value }) => `${sourceName} ${record.resourceType} ${system}|${value}`
  )

/** A source that gives a `mergeResources`. */
type MergingSource = SourceDescriptor.SourceDescriptor<FhirResource> &
  Required<Pick<SourceDescriptor.SourceDescriptor<FhirResource>, 'mergeResources'>>

const givesMerge = (
  source: SourceDescriptor.SourceDescriptor<FhirResource>
): source is MergingSource => source.mergeResources !== undefined

/** One identity's records merged so far, and the review key of the first to arrive. */
interface MergedIdentity {
  readonly firstKey: string
  readonly resource: DetachedResource.Type
}

/**
 * Merge the previewed records that share an identity, for each source that
 * gives a `mergeResources`.
 *
 * @param sources - The registered sources; a response's pick is matched to its
 *   source by kind name
 * @param previews - Every response's preview, in archive order
 * @returns The same previews, where each identity with a merge is held once:
 *   the merged record under the first copy's review key and in its place, the
 *   later copies dropped. A source without a merge keeps every copy, and so
 *   does every keyless record.
 */
const mergeSharedResources = <K>(
  sources: readonly SourceDescriptor.SourceDescriptor<FhirResource>[],
  previews: readonly PreviewedResponse<K, DetachedResource.Type>[]
): readonly PreviewedResponse<K, DetachedResource.Type>[] => {
  const mergingSourceByKindName = new Map(
    sources
      .filter(givesMerge)
      .flatMap((source) => source.responseKinds.map((kind) => [kind.name, source] as const))
  )
  const mergingSourceOf = (
    preview: PreviewedResponse<K, DetachedResource.Type>
  ): Option.Option<MergingSource> =>
    Option.flatMap(preview.pickKindName, (kindName) =>
      Option.fromNullable(mergingSourceByKindName.get(kindName))
    )

  const mergedByIdentity = new Map<string, MergedIdentity>()
  for (const preview of previews) {
    if (preview.outcome._tag !== 'resources') continue
    const source = mergingSourceOf(preview)
    if (Option.isNone(source)) continue
    const { name, mergeResources } = source.value
    for (const { key, resource } of preview.outcome.resources) {
      const identity = identityOf(name, resource)
      if (Option.isNone(identity)) continue
      const earlier = mergedByIdentity.get(identity.value)
      mergedByIdentity.set(
        identity.value,
        earlier === undefined
          ? { firstKey: key, resource }
          : { firstKey: earlier.firstKey, resource: mergeResources(earlier.resource, resource) }
      )
    }
  }

  /** One record's place after the merge: the merged copy, or nothing for a later copy. */
  const heldCopyOf =
    (sourceName: string) =>
    (
      previewed: PreviewedResource<DetachedResource.Type>
    ): readonly PreviewedResource<DetachedResource.Type>[] =>
      Option.match(
        Option.flatMapNullable(identityOf(sourceName, previewed.resource), (identity) =>
          mergedByIdentity.get(identity)
        ),
        {
          onNone: () => [previewed],
          onSome: (merged) =>
            merged.firstKey === previewed.key ? [{ ...previewed, resource: merged.resource }] : [],
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
        resources: preview.outcome.resources.flatMap(heldCopyOf(source.value.name)),
      },
    }
  })
}

export { mergeSharedResources }
