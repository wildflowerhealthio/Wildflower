import { Effect, Option } from 'effect'

import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import type { SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'

import type { PreviewedResponse } from './review.ts'

/**
 * Where an archive import applies each source's `completeFromExtraction`:
 * over the whole preview, once every response has parsed and every merge has
 * run, before anything is reviewed or written.
 *
 * @packageDocumentation
 */

/** A source that gives a `completeFromExtraction`. */
type CompletingSource = SourceDescriptor.SourceDescriptor<FhirResource> &
  Required<Pick<SourceDescriptor.SourceDescriptor<FhirResource>, 'completeFromExtraction'>>

const givesCompletion = (
  source: SourceDescriptor.SourceDescriptor<FhirResource>
): source is CompletingSource => source.completeFromExtraction !== undefined

/**
 * Complete the previewed resources of each source that gives a
 * `completeFromExtraction`, from every resource that source's kinds emitted.
 *
 * @param sources - The registered sources; a response's pick is matched to its
 *   source by kind name
 * @param previews - Every response's preview, in archive order, merged
 *   (`mergeSharedResources`)
 * @returns The same previews, each resource of a completing source replaced by
 *   its completion under the same key. A source without one is left as it is.
 *
 * @remarks
 * A source's completion sees only its own resources, as its merge does, so
 * one source never completes from another's.
 */
const completeFromExtraction = <K>(
  sources: readonly SourceDescriptor.SourceDescriptor<FhirResource>[],
  previews: readonly PreviewedResponse<K, FhirResource>[]
): Effect.Effect<readonly PreviewedResponse<K, FhirResource>[]> =>
  Effect.gen(function* () {
    const completingSourceByKindName = new Map(
      sources
        .filter(givesCompletion)
        .flatMap((source) => source.responseKinds.map((kind) => [kind.name, source] as const))
    )
    const completingSourceOf = (
      preview: PreviewedResponse<K, FhirResource>
    ): Option.Option<CompletingSource> =>
      Option.flatMap(preview.pickKindName, (kindName) =>
        Option.fromNullable(completingSourceByKindName.get(kindName))
      )

    const extractionBySourceName = new Map<string, FhirResource[]>()
    for (const preview of previews) {
      if (preview.outcome._tag !== 'resources') continue
      const source = completingSourceOf(preview)
      if (Option.isNone(source)) continue
      const extraction = extractionBySourceName.get(source.value.name) ?? []
      extraction.push(...preview.outcome.resources.map(({ resource }) => resource))
      extractionBySourceName.set(source.value.name, extraction)
    }

    const completionBySourceName = new Map<string, (resource: FhirResource) => FhirResource>()
    for (const source of completingSourceByKindName.values()) {
      const extraction = extractionBySourceName.get(source.name)
      if (extraction === undefined || completionBySourceName.has(source.name)) continue
      completionBySourceName.set(source.name, yield* source.completeFromExtraction(extraction))
    }

    return previews.map((preview) => {
      if (preview.outcome._tag !== 'resources') return preview
      const completion = Option.flatMap(completingSourceOf(preview), (source) =>
        Option.fromNullable(completionBySourceName.get(source.name))
      )
      if (Option.isNone(completion)) return preview
      return {
        ...preview,
        outcome: {
          ...preview.outcome,
          resources: preview.outcome.resources.map((previewed) => ({
            ...previewed,
            resource: completion.value(previewed.resource),
          })),
        },
      }
    })
  })

export { completeFromExtraction }
