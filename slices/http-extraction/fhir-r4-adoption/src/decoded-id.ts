import { type FhirResource, FhirResourceSchema } from '@wildflowerhealthio/fhir-r4/resources'
import { fnv1a64 } from '@wildflowerhealthio/kitchen-sink'
import { Data, Schema, Struct } from 'effect'

/**
 * The id a decoded resource is adopted under: the hash input that, with the
 * source's system and the resource type, derives its local id.
 *
 * @remarks
 * `FoundInSource` when the source gave the resource an id, which is also recorded on
 * the adopted resource as its source identifier. `GeneratedFromContent` when it
 * gave none (third-party FHIR JSON, where `id` is optional), so the id is a
 * digest of the resource's content ({@link of}); no source identifier is
 * recorded for it, since the source knows the resource by no id at all.
 */
type Type = Data.TaggedEnum<{
  FoundInSource: { readonly value: string }
  GeneratedFromContent: { readonly value: string }
}>

const { FoundInSource, GeneratedFromContent, $match } = Data.taggedEnum<Type>()

const encodeResource = Schema.encodeSync(FhirResourceSchema)

/**
 * Sixteen hex digits of FNV-1a 64 over the resource's FHIR JSON, without its
 * `meta`.
 *
 * @remarks
 * The JSON is the resource encoded through {@link FhirResourceSchema}, which
 * writes its fields in schema order whatever order the source sent them in,
 * so the same content always digests the same. `meta` is left out because it
 * describes the response (`lastUpdated`, `versionId`), not the record: a fresh
 * capture of the same record digests the same.
 *
 * A resource that does not encode is a defect, thrown here: it means a
 * kind's decode let through what the schema's encode refuses.
 */
const contentDigestOf = (resource: FhirResource): string =>
  fnv1a64(JSON.stringify(Struct.omit(encodeResource(resource), 'meta')))
    .toString(16)
    .padStart(16, '0')

/**
 * The id `resource` is adopted under: its own, or, when it has none, a digest
 * of its content.
 *
 * @param resource - A resource as its source decoded it
 * @returns `FoundInSource` its `id`, or `GeneratedFromContent` its content digest
 *   when its `id` is `null`
 */
const of = (resource: FhirResource): Type =>
  resource.id === null
    ? GeneratedFromContent({ value: contentDigestOf(resource) })
    : FoundInSource({ value: resource.id })

export { $match, of }
export type { Type }
