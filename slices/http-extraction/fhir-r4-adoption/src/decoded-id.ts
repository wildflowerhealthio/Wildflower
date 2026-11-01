import { joinIdComponents } from '@wildflowerhealthio/fhir-r4/identity'
import { type FhirResource, FhirResourceSchema } from '@wildflowerhealthio/fhir-r4/resources'
import { fnv1a64 } from '@wildflowerhealthio/kitchen-sink'
import { Data, Schema, Struct } from 'effect'

/**
 * The id a decoded resource is adopted under: its source id, which with its
 * id space and type keys it.
 *
 * @remarks
 * `FoundInSource` when the source gave the resource an id, keyed in the
 * source's own id space. `GeneratedFromContent` when it gave none (third-party
 * FHIR JSON, where `id` is optional), so the id is a digest of the resource's
 * content ({@link of}), keyed in `IdSpace.CONTENT_DIGEST`. Either is recorded
 * as the adopted resource's source identifier.
 */
type Type = Data.TaggedEnum<{
  FoundInSource: { readonly value: string }
  GeneratedFromContent: { readonly value: string }
}>

const { FoundInSource, GeneratedFromContent, $match } = Data.taggedEnum<Type>()

const encodeResource = Schema.encodeSync(FhirResourceSchema)

/**
 * Sixteen hex digits of FNV-1a 64 over `scope` and the resource's FHIR JSON,
 * without its `meta`.
 *
 * @remarks
 * `scope` is the id space the resource's id would have had in its source. The
 * digest space is shared by every source, and a record's relative references
 * mean different targets in different sources, so the same content from two
 * sources must not digest to one id.
 *
 * The JSON is the resource encoded through {@link FhirResourceSchema}, which
 * writes its fields in schema order whatever order the source sent them in,
 * so the same content always digests the same. `meta` is left out because it
 * describes the response (`lastUpdated`, `versionId`), not the record: a fresh
 * capture of the same record digests the same.
 *
 * A resource that does not encode is a defect, thrown here: it means a
 * kind's decode let through what the schema's encode refuses.
 */
const contentDigestOf = (scope: string, resource: FhirResource): string =>
  fnv1a64(joinIdComponents([scope, JSON.stringify(Struct.omit(encodeResource(resource), 'meta'))]))
    .toString(16)
    .padStart(16, '0')

/**
 * The id `resource` is adopted under: its own, or, when it has none, a digest
 * of its content.
 *
 * @param scope - The id space the resource's own id would be in
 * @param resource - A resource as its source decoded it
 * @returns `FoundInSource` its `id`, or `GeneratedFromContent` its content digest
 *   when its `id` is `null`
 */
const of = (scope: string, resource: FhirResource): Type =>
  resource.id === null
    ? GeneratedFromContent({ value: contentDigestOf(scope, resource) })
    : FoundInSource({ value: resource.id })

export { $match, of }
export type { Type }
