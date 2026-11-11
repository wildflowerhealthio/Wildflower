/**
 * A file set's record: one record read from a file set or implied by it, not
 * yet given an id, beside its local key.
 *
 * @packageDocumentation
 */
import type { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { Option } from 'effect'

/**
 * One record of a file set: the record as its source gave it, detached
 * (`fhir-r4-adoption`'s `DetachedResource`: no id, keyed by its first
 * identifier, naming every other record of the set by a logical reference),
 * beside its local key and the URL its source served it at, if any.
 *
 * @remarks
 * `localKey` is the decoder's stable name for the record within its set: it
 * only has to be unique within the set, and it is stable across a settings
 * re-decode. Its one job is to become the record's review key, which the
 * import stage builds from it (`DecodedFileSet.adopt`). It is not the
 * record's `id`: `id: null` is what marks a record detached.
 *
 * `sourceUrl` is the URL a source served the record at, for a record that
 * nothing else names: a `Binary` a FHIR server served by a read, at
 * `<base>/Binary/<id>` (`DetachedResource.serverBinaryUrlIfRead`), which is
 * the URL a reference or an `Attachment.url` to it is detached to. The import
 * stage resolves those to the record by it, as a FHIR server resolves a
 * transaction bundle's literal references by `Bundle.entry.fullUrl`. `None`
 * for every other record.
 */
interface Type {
  readonly localKey: string
  readonly resource: DetachedResource.Type
  readonly sourceUrl: Option.Option<URL>
}

export type { Type }
