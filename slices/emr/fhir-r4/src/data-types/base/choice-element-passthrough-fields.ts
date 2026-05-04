import { type Schema } from 'effect'
import type { LazyArg } from 'effect/Function'

import { ChoiceElementSet, type Datatype } from 'emr-core/schemas'
import { OrNullAsOptional } from 'kitchen-sink/schema'

// FHIR R4 `value[x]` choice elements are emitted on the wire as optional
// `${prefix}${Capitalize<datatype>}` fields whose value is the datatype's
// encoded form, with absent fields meaning "no value". emr-core's
// `ChoiceElementSet.SchemaFields` produces `Schema.NullOr<S>` fields backed
// by the lazy datatype registry — its encoded shape is `E | null`. FHIR R4
// uses `E | undefined`, so we re-wrap each field with `OrNullAsOptional` to
// translate null↔undefined at the encoding boundary while keeping the
// registry-backed lazy resolution.
const choiceElementSetPassthroughFields = <
  const Prefix extends string,
  const DatatypeNames extends readonly Datatype.Name[],
>(
  prefix: Prefix,
  datatypeNames: DatatypeNames
): {
  [K in DatatypeNames[number] as `${Prefix}${Capitalize<K>}`]: Schema.optionalWith<
    Schema.Schema<
      Schema.Schema.Type<Datatype.SchemaFor<K>> | null,
      Schema.Schema.Encoded<Datatype.SchemaFor<K>> | undefined
    >,
    { default: LazyArg<Schema.Schema.Type<Datatype.SchemaFor<K>> | null> }
  >
} => {
  type Fields = {
    [K in DatatypeNames[number] as `${Prefix}${Capitalize<K>}`]: Schema.optionalWith<
      Schema.Schema<
        Schema.Schema.Type<Datatype.SchemaFor<K>> | null,
        Schema.Schema.Encoded<Datatype.SchemaFor<K>> | undefined
      >,
      { default: LazyArg<Schema.Schema.Type<Datatype.SchemaFor<K>> | null> }
    >
  }

  const lazyFields = ChoiceElementSet.SchemaFields(prefix, datatypeNames)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return Object.fromEntries(
    Object.entries(lazyFields).map(([key, schema]) => [
      key,
      // The cast widens away the inner `Schema.NullOr<S>` so OrNullAsOptional
      // owns the null/undefined transform on the encoded boundary. Runtime is
      // consistent: a `null` input encodes to undefined via OrNullAsOptional
      // before reaching the inner NullOr.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      OrNullAsOptional(schema as Schema.Schema<unknown, unknown, never>),
    ])
  ) as Fields
}

export { choiceElementSetPassthroughFields }
