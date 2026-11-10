/**
 * A file set's record: one record read from a file set or implied by it, not
 * yet given an id, beside its local key.
 *
 * @packageDocumentation
 */
import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'

/**
 * One record of a file set: the record as its source gave it, detached
 * (`fhir-r4-adoption`'s `DetachedResource`: no id, keyed by its first
 * identifier, naming every other record of the set by a logical reference),
 * beside its local key.
 *
 * @remarks
 * `localKey` is the decoder's stable name for the record within its set: it
 * only has to be unique within the set, and it is stable across a settings
 * re-decode. Its one job is to become the record's review key, which the
 * import stage builds from it (`DecodedFileSet.adopt`). It is not the
 * record's `id`: `id: null` is what marks a record detached.
 */
interface Type {
  readonly localKey: string
  readonly resource: DetachedResource.Type
}

export type { Type }
