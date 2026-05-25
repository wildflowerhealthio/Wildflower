import { Data, Effect, type Schema } from 'effect'

import { Datatype } from 'emr-core/schemas'

// Sibling registry: `slices/emr/emr-core/src/schemas/datatype-registry.ts`.
// emr-core's covers the full FHIR R4 `Datatype.Name` set with a
// `PermissivePassthrough` fallback for unregistered slots; this one is the
// fhir-r4 adapter's wire-format subset and surfaces unregistered slots as a
// typed `UnregisteredDatatype` error. Keep both in lockstep on signature
// changes — see PR #61 for the divergence rationale.

class UnregisteredDatatype extends Data.TaggedError('UnregisteredDatatype')<{
  readonly name: string
}> {
  override get message(): string {
    return (
      `fhir-r4 datatype "${this.name}" is in the manifest but no schema is registered. ` +
      `Ensure the module that owns this datatype has loaded before decoding/encoding through value[x].`
    )
  }
}

/** Lookup of fhir-r4 wire-format schemas. Primitives are seeded from emr-core's
 * `Datatype.baseSchemas`; complex slots start as `undefined` and are filled by
 * the collation block at the bottom of `choice-element-passthrough-fields.ts`.
 */
const baseDatatypes: {
  boolean: Datatype.SchemaFor<'boolean'> | undefined
  canonical: Datatype.SchemaFor<'canonical'> | undefined
  date: Datatype.SchemaFor<'date'> | undefined
  dateTime: Datatype.SchemaFor<'dateTime'> | undefined
  decimal: Datatype.SchemaFor<'decimal'> | undefined
  id: Datatype.SchemaFor<'id'> | undefined
  instant: Datatype.SchemaFor<'instant'> | undefined
  integer: Datatype.SchemaFor<'integer'> | undefined
  string: Datatype.SchemaFor<'string'> | undefined
  time: Datatype.SchemaFor<'time'> | undefined
  uri: Datatype.SchemaFor<'uri'> | undefined
  url: Datatype.SchemaFor<'url'> | undefined
  Address: Datatype.SchemaFor<'Address'> | undefined
  Annotation: Datatype.SchemaFor<'Annotation'> | undefined
  Attachment: Datatype.SchemaFor<'Attachment'> | undefined
  CodeableConcept: Datatype.SchemaFor<'CodeableConcept'> | undefined
  Coding: Datatype.SchemaFor<'Coding'> | undefined
  ContactPoint: Datatype.SchemaFor<'ContactPoint'> | undefined
  HumanName: Datatype.SchemaFor<'HumanName'> | undefined
  Identifier: Datatype.SchemaFor<'Identifier'> | undefined
  Meta: Datatype.SchemaFor<'Meta'> | undefined
  Period: Datatype.SchemaFor<'Period'> | undefined
  Quantity: Datatype.SchemaFor<'Quantity'> | undefined
  Range: Datatype.SchemaFor<'Range'> | undefined
  Ratio: Datatype.SchemaFor<'Ratio'> | undefined
  Reference: Datatype.SchemaFor<'Reference'> | undefined
  SampledData: Datatype.SchemaFor<'SampledData'> | undefined
  SimpleQuantity: Datatype.SchemaFor<'SimpleQuantity'> | undefined
  Timing: Datatype.SchemaFor<'Timing'> | undefined
} = {
  boolean: Datatype.baseSchemas.boolean,
  canonical: Datatype.baseSchemas.canonical,
  date: Datatype.baseSchemas.date,
  dateTime: Datatype.baseSchemas.dateTime,
  decimal: Datatype.baseSchemas.decimal,
  id: Datatype.baseSchemas.id,
  instant: Datatype.baseSchemas.instant,
  integer: Datatype.baseSchemas.integer,
  string: Datatype.baseSchemas.string,
  time: Datatype.baseSchemas.time,
  uri: Datatype.baseSchemas.uri,
  url: Datatype.baseSchemas.url,
  Address: undefined,
  Annotation: undefined,
  Attachment: undefined,
  CodeableConcept: undefined,
  Coding: undefined,
  ContactPoint: undefined,
  HumanName: undefined,
  Identifier: undefined,
  Meta: undefined,
  Period: undefined,
  Quantity: undefined,
  Range: undefined,
  Ratio: undefined,
  Reference: undefined,
  SampledData: undefined,
  SimpleQuantity: undefined,
  Timing: undefined,
}

type Name = keyof typeof baseDatatypes

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- baseDatatypes is typed with `Name` keys exclusively, so Object.keys narrows from `string[]` to `Name[]` by construction.
const registeredNames: readonly Name[] = Object.keys(baseDatatypes) as readonly Name[]

/** Package-private — never re-export from the barrel. Each complex datatype
 * calls this once at the bottom of its own module file.
 */
const registerDatatypeSchema = <N extends Name>(name: N, schema: Datatype.SchemaFor<N>): void => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- TS can't bridge `Datatype.SchemaFor<N>` and `baseDatatypes[N]` through a generic (invariant mapped-type indexing); the assignment is sound by the per-N typing of both sides.
  baseDatatypes[name] = schema as unknown as (typeof baseDatatypes)[N]
}

/** Returns the registered schema or fails with `UnregisteredDatatype`. */
const resolveDatatypeSchema = <N extends Name>(
  name: N
): Effect.Effect<Datatype.SchemaFor<N>, UnregisteredDatatype> => {
  const schema = baseDatatypes[name]
  return schema === undefined
    ? Effect.fail(new UnregisteredDatatype({ name }))
    : // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the per-N typing is preserved by registerDatatypeSchema's `Datatype.SchemaFor<N>` parameter; widen-then-narrow recovers that at the call site.
      Effect.succeed(schema as Schema.Schema.AnyNoContext as Datatype.SchemaFor<N>)
}

export {
  baseDatatypes,
  registerDatatypeSchema,
  registeredNames,
  resolveDatatypeSchema,
  UnregisteredDatatype,
  type Name,
}
