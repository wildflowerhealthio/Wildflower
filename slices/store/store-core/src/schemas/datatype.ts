import { Schema } from 'effect'

import { PermissivePassthrough } from 'kitchen-sink/schema'

import FhirR4ChoiceElements from './fhir-r4-choice-elements.ts'

/**
 * A named FHIR data type paired with its Effect Schema. Used to build
 * choice-element (value\[x\]) unions via {@link DatatypeChoice}.
 *
 * @typeParam Name - The FHIR data type name (e.g. `'string'`, `'CodeableConcept'`)
 * @typeParam A - Decoded type
 * @typeParam I - Encoded type
 */
interface Datatype<out Name extends string, A, I> {
  readonly name: Name
  readonly schema: Schema.Schema<A, I>
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- `Others` lets callers preserve their tagged-union type through the call instead of widening to `{ _tag: string }`.
  from: <Others extends { _tag: string }>(
    value: Others | undefined | ({ _tag: Name } & Record<Name, A>)
  ) => A | undefined
}

/**
 * Factory function to create a Datatype.
 *
 * Builds a `Schema.Struct({ value${Name}: schema })` for use in DatatypeChoice.
 */
const Datatype = <const Name extends string, A, I>(
  name: Name,
  schema: Schema.Schema<A, I>
): Datatype<Name, A, I> =>
  ({
    // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- `Others` lets callers preserve their tagged-union type through the call instead of widening to `{ _tag: string }`.
    from: <Others extends { _tag: string }>(
      value: Others | undefined | ({ _tag: Name } & { [K in Name]: A })
    ) =>
      // oxlint-disable-next-line eslint/no-ternary, typescript/no-unsafe-type-assertion
      value && value._tag === name && (value as { [K in Name]?: A })[name] !== undefined
        ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          (value as { [K in Name]: A })[name]
        : undefined,
    name,
    schema,
  }) as const

// ---------------------------------------------------------------------------
// Primitive datatypes (no external imports beyond Code)
// ---------------------------------------------------------------------------

const StringDatatype = Datatype('string', Schema.String)
const BooleanDatatype = Datatype('boolean', Schema.Boolean)
const DecimalDatatype = Datatype('decimal', Schema.Finite)
const IntegerDatatype = Datatype('integer', Schema.Int)
const DateDatatype = Datatype('date', Schema.Date)
const DateTimeDatatype = Datatype('dateTime', Schema.DateTimeUtc)
const TimeDatatype = Datatype('time', Schema.String)
const UriDatatype = Datatype('uri', Schema.String)
const UrlDatatype = Datatype('url', Schema.String)
const CanonicalDatatype = Datatype('canonical', Schema.String)

/**
 * Lookup table of all FHIR R4 data type names to their {@link Datatype}
 * definitions. Primitive types use typed schemas; complex types that are not
 * yet fully modeled use a permissive `PermissivePassthrough` placeholder.
 */
const baseDatatypes = {
  string: StringDatatype,
  boolean: BooleanDatatype,
  decimal: DecimalDatatype,
  integer: IntegerDatatype,
  date: DateDatatype,
  dateTime: DateTimeDatatype,
  time: TimeDatatype,
  uri: UriDatatype,
  url: UrlDatatype,
  canonical: CanonicalDatatype,
  code: Datatype('code', PermissivePassthrough),
  Reference: Datatype('Reference', PermissivePassthrough),
  Identifier: Datatype('Identifier', PermissivePassthrough),
  // Primitive types
  base64Binary: Datatype('base64Binary', PermissivePassthrough),
  id: Datatype('id', PermissivePassthrough),
  instant: Datatype('instant', PermissivePassthrough),
  markdown: Datatype('markdown', PermissivePassthrough),
  oid: Datatype('oid', PermissivePassthrough),
  positiveInt: Datatype('positiveInt', PermissivePassthrough),
  unsignedInt: Datatype('unsignedInt', PermissivePassthrough),
  uuid: Datatype('uuid', PermissivePassthrough),
  // Complex data types
  Address: Datatype('Address', PermissivePassthrough),
  Age: Datatype('Age', PermissivePassthrough),
  Annotation: Datatype('Annotation', PermissivePassthrough),
  Attachment: Datatype('Attachment', PermissivePassthrough),
  CodeableConcept: Datatype('CodeableConcept', PermissivePassthrough),
  Coding: Datatype('Coding', PermissivePassthrough),
  ContactPoint: Datatype('ContactPoint', PermissivePassthrough),
  Count: Datatype('Count', PermissivePassthrough),
  Distance: Datatype('Distance', PermissivePassthrough),
  Duration: Datatype('Duration', PermissivePassthrough),
  HumanName: Datatype('HumanName', PermissivePassthrough),
  Money: Datatype('Money', PermissivePassthrough),
  Period: Datatype('Period', PermissivePassthrough),
  Quantity: Datatype('Quantity', PermissivePassthrough),
  Range: Datatype('Range', PermissivePassthrough),
  Ratio: Datatype('Ratio', PermissivePassthrough),
  SampledData: Datatype('SampledData', PermissivePassthrough),
  Signature: Datatype('Signature', PermissivePassthrough),
  SimpleQuantity: Datatype('SimpleQuantity', PermissivePassthrough),
  Timing: Datatype('Timing', PermissivePassthrough),
  // Metadata types
  MetaDataTypes: Datatype('MetaDataTypes', PermissivePassthrough),
  ContactDetail: Datatype('ContactDetail', PermissivePassthrough),
  Contributor: Datatype('Contributor', PermissivePassthrough),
  DataRequirement: Datatype('DataRequirement', PermissivePassthrough),
  Expression: Datatype('Expression', PermissivePassthrough),
  ParameterDefinition: Datatype('ParameterDefinition', PermissivePassthrough),
  RelatedArtifact: Datatype('RelatedArtifact', PermissivePassthrough),
  TriggerDefinition: Datatype('TriggerDefinition', PermissivePassthrough),
  UsageContext: Datatype('UsageContext', PermissivePassthrough),
  // Special types
  Dosage: Datatype('Dosage', PermissivePassthrough),
  Meta: Datatype('Meta', PermissivePassthrough),
} as const

/** All data type names available for choice-element fields. */
const AllDatatypeNames = FhirR4ChoiceElements['*']

/** String-literal union of all data type names in {@link baseDatatypes}. */
type DatatypeName = keyof typeof baseDatatypes

export {
  AllDatatypeNames,
  baseDatatypes,
  BooleanDatatype,
  CanonicalDatatype,
  Datatype,
  type DatatypeName,
  DateDatatype,
  DateTimeDatatype,
  DecimalDatatype,
  FhirR4ChoiceElements,
  IntegerDatatype,
  StringDatatype,
  TimeDatatype,
  UriDatatype,
  UrlDatatype,
}
