import { Option } from 'effect'

import type { FhirResource } from 'fhir-r4/resources'
import type { SourceDescriptor } from 'http-extraction-fundamentals'

import type { PreviewedResource, PreviewedResponse } from './review.ts'

/**
 * Where an archive import applies each source's `mergeResources`: over the
 * whole preview, once every response has parsed and before anything is
 * reviewed or written.
 *
 * @packageDocumentation
 */

/**
 * The key two resources merge under: their source, then `resourceType/id`.
 * The source is part of it so one source's merge never sees another's
 * resource.
 */
const identityOf = (sourceName: string, resource: FhirResource): Option.Option<string> =>
  resource.id === null
    ? Option.none()
    : Option.some(`${sourceName} ${resource.resourceType}/${resource.id}`)

/** A source that gives a `mergeResources`. */
type MergingSource = SourceDescriptor.SourceDescriptor<FhirResource> &
  Required<Pick<SourceDescriptor.SourceDescriptor<FhirResource>, 'mergeResources'>>

const givesMerge = (
  source: SourceDescriptor.SourceDescriptor<FhirResource>
): source is MergingSource => source.mergeResources !== undefined

/** One identity's resources merged so far, and the key of the first to arrive. */
interface MergedIdentity {
  readonly firstKey: string
  readonly resource: FhirResource
}

/**
 * Merge the previewed resources that share an identity, for each source that
 * gives a `mergeResources`.
 *
 * @param sources - The registered sources; a response's pick is matched to its
 *   source by kind name
 * @param previews - Every response's preview, in archive order
 * @returns The same previews, where each identity with a merge is held once:
 *   the merged resource under the first copy's key and in its place, the
 *   later copies dropped. A source without a merge keeps every copy.
 */
const mergeSharedResources = <K>(
  sources: readonly SourceDescriptor.SourceDescriptor<FhirResource>[],
  previews: readonly PreviewedResponse<K, FhirResource>[]
): readonly PreviewedResponse<K, FhirResource>[] => {
  const mergingSourceByKindName = new Map(
    sources
      .filter(givesMerge)
      .flatMap((source) => source.responseKinds.map((kind) => [kind.name, source] as const))
  )
  const mergingSourceOf = (
    preview: PreviewedResponse<K, FhirResource>
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

  /** One resource's place after the merge: the merged copy, or nothing for a later copy. */
  const heldCopyOf =
    (sourceName: string) =>
    (previewed: PreviewedResource<FhirResource>): readonly PreviewedResource<FhirResource>[] =>
      Option.match(identityOf(sourceName, previewed.resource), {
        onNone: () => [previewed],
        onSome: (identity) => {
          const merged = mergedByIdentity.get(identity)
          if (merged === undefined) return [previewed]
          return merged.firstKey === previewed.key
            ? [{ ...previewed, resource: merged.resource }]
            : []
        },
      })

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
