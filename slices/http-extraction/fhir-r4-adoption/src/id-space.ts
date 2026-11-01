import { Data, Option } from 'effect'

/**
 * The space a decoded record's id belongs to: who assigned the id, and so what
 * derives the record's local id from it and what the record's references mean.
 *
 * @remarks
 * - `FhirServer` — an id a FHIR server assigned. `base` is the server's root,
 *   the hash domain and source identifier system; the server spells its own
 *   references absolutely under `${base}/` as well as relatively.
 * - `SourceSystem` — an id a scraped source or a file format assigned, in a
 *   Wildflower-minted coding `system` (a pharmacy's account `sid`, LifeLabs'
 *   or DICOM's digest space).
 * - `ContentDigest` — a record its source gave no id, keyed by a digest of its
 *   content. It is hashed, and its references read, `within` the space its
 *   source's other records are in, but no source identifier records the
 *   digest: the source knows the record by no id at all.
 * - `SourceFile` — a picked file's own `DocumentReference`, keyed in its
 *   format's coding `system` by a digest of the file. No source identifier.
 *   Adoption rewrites its references like any other record's, so it is
 *   adopted as minted, before anything links it to what it holds.
 */
type Type = Data.TaggedEnum<{
  FhirServer: { readonly base: string }
  SourceSystem: { readonly system: string }
  ContentDigest: { readonly within: Origin }
  SourceFile: { readonly system: string }
}>

/** A space whose ids the source assigned: what a {@link Type} `ContentDigest` sits `within`. */
type Origin = Data.TaggedEnum<{
  FhirServer: { readonly base: string }
  SourceSystem: { readonly system: string }
}>

const { FhirServer, SourceSystem, ContentDigest, SourceFile, $match } = Data.taggedEnum<Type>()

/**
 * The domain a record's local id is hashed under: the first component of
 * `localResourceId`, for the record and for every reference it holds.
 *
 * @remarks
 * It is also the `Identifier.system` of every source identifier adoption
 * writes, so it must be an absolute URI.
 */
const hashDomainOf = (idSpace: Type): string =>
  $match(idSpace, {
    FhirServer: ({ base }) => base,
    SourceSystem: ({ system }) => system,
    ContentDigest: ({ within }) => hashDomainOf(within),
    SourceFile: ({ system }) => system,
  })

/**
 * Whether the source assigned the id, so a source identifier can record it.
 * A content digest or a source file's id is Wildflower's, not the source's.
 */
const isSourceAssigned = (idSpace: Type): boolean =>
  $match(idSpace, {
    FhirServer: () => true,
    SourceSystem: () => true,
    ContentDigest: () => false,
    SourceFile: () => false,
  })

/**
 * The `${base}/` prefix a FHIR server's absolute self-references carry, read
 * back to their relative form; `None` when the space is not a FHIR server's.
 */
const selfReferencePrefixIfFhirServer = (idSpace: Type): Option.Option<string> =>
  $match(idSpace, {
    FhirServer: ({ base }) => Option.some(`${base}/`),
    SourceSystem: () => Option.none(),
    ContentDigest: ({ within }) => selfReferencePrefixIfFhirServer(within),
    SourceFile: () => Option.none(),
  })

/**
 * The URI naming the space a `resourceType` id sits in: `<base>/<Type>` for a
 * FHIR server, whose ids are unique per type, and the coding system otherwise.
 *
 * @remarks
 * A content digest names the space it sits `within`, not a space of its own.
 * Its local id is hashed in that space too, so a digest and a source id with
 * the same text are one (id space, type, id) key exactly as they are one
 * derived id: a key that told them apart would let two records claim the same
 * local id.
 */
const uriOf = (idSpace: Type, resourceType: string): string =>
  $match(idSpace, {
    FhirServer: ({ base }) => `${base}/${resourceType}`,
    SourceSystem: ({ system }) => system,
    ContentDigest: ({ within }) => uriOf(within, resourceType),
    SourceFile: ({ system }) => system,
  })

export {
  $match,
  ContentDigest,
  FhirServer,
  SourceFile,
  SourceSystem,
  hashDomainOf,
  isSourceAssigned,
  selfReferencePrefixIfFhirServer,
  uriOf,
}
export type { Origin, Type }
