import type { Schema } from 'effect'

import type { BackboneElement, DomainResource, Extension } from 'fhir-r4/data-types'
import type * as FhirR4 from 'fhir/r4.d.ts'

type DomainResourceDecoded = Schema.Struct.Type<typeof DomainResource.fields>

type BackboneElementDecoded = Schema.Struct.Type<typeof BackboneElement.fields>

/**
 * Decoded FHIR DomainResource base fields, shared by the STU3 dialect resource
 * types. The reused fhir-r4 `Extension` type is referenced through its public
 * name so the STU3 slice's generated `.d.ts` stays portable (`tsgo` cannot
 * name fhir-r4's internal `ExtensionType` interface from an inferred type — see
 * TS2883 — so we spell it out here). Every other base field is projected from
 * the fhir-r4 `DomainResource.fields` decoded type, which is structural and
 * already portable.
 */
interface Stu3DomainResourceFields {
  readonly id: DomainResourceDecoded['id']
  readonly implicitRules: DomainResourceDecoded['implicitRules']
  readonly language: DomainResourceDecoded['language']
  readonly meta: DomainResourceDecoded['meta']
  readonly text: DomainResourceDecoded['text']
  readonly contained: DomainResourceDecoded['contained']
  readonly extension: readonly Extension.Type[]
  readonly modifierExtension: readonly Extension.Type[]
}

/**
 * Decoded FHIR BackboneElement base fields (id + extension + modifierExtension),
 * shared by the STU3 dialect backbone types (`requester`, `dispenseRequest`).
 * See {@link Stu3DomainResourceFields} for why `Extension` is spelled out.
 */
interface Stu3BackboneElementFields {
  readonly id: BackboneElementDecoded['id']
  readonly extension: readonly Extension.Type[]
  readonly modifierExtension: readonly Extension.Type[]
}

/**
 * Encoded (wire) base fields shared by the STU3 dialect resource types.
 *
 * The STU3 schemas reuse the fhir-r4 datatype schemas, whose encoded side is
 * the FHIR R4 wire type (e.g. `FhirR4.Extension`). We spell the encoded shape
 * out explicitly (rather than deriving it from the field schemas) so the
 * generated `.d.ts` never has to name fhir-r4's internal decoded interfaces —
 * see the decoded bases above and TS2883. The R4 and STU3 wire shapes for
 * these datatypes are identical, which is exactly why the reuse is sound.
 */
interface Stu3DomainResourceEncoded {
  resourceType: string
  id?: string | undefined
  implicitRules?: string | undefined
  language?: string | undefined
  meta?: FhirR4.Meta | undefined
  text?: FhirR4.Narrative | undefined
  contained?: unknown[] | undefined
  extension?: FhirR4.Extension[] | undefined
  modifierExtension?: FhirR4.Extension[] | undefined
}

/** Encoded (wire) BackboneElement base fields. See {@link Stu3DomainResourceEncoded}. */
interface Stu3BackboneElementEncoded {
  id?: string | undefined
  extension?: FhirR4.Extension[] | undefined
  modifierExtension?: FhirR4.Extension[] | undefined
}

export type {
  Stu3DomainResourceFields,
  Stu3BackboneElementFields,
  Stu3DomainResourceEncoded,
  Stu3BackboneElementEncoded,
}
