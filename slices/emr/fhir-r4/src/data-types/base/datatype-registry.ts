import { type Schema } from 'effect'

import { Datatype } from 'emr-core/schemas'

/**
 * Manifest of every FHIR R4 datatype that this package ships a wire-format
 * Effect schema for. Used as both the type-level coupling set for
 * {@link choiceElementSetPassthroughFields | choiceElementSetPassthroughFields}
 * and the runtime keyset for {@link baseDatatypes}.
 *
 * Adding a datatype here without also wiring up a `registerDatatypeSchema`
 * call (for complex types) or a primitive seed below will surface as a
 * "datatype not registered" throw at decode/encode time through `value[x]`.
 */
const registeredNames = [
  // Primitives — seeded below from `Datatype.baseSchemas`.
  'boolean',
  'canonical',
  'date',
  'dateTime',
  'decimal',
  'id',
  'integer',
  'string',
  'time',
  'uri',
  'url',
  // Complex / base — self-register at the bottom of their module file.
  'Address',
  'Annotation',
  'Attachment',
  'CodeableConcept',
  'Coding',
  'ContactPoint',
  'HumanName',
  'Identifier',
  'Meta',
  'Period',
  'Quantity',
  'Range',
  'Reference',
] as const satisfies readonly Datatype.Name[]

type Name = (typeof registeredNames)[number]

// oxlint-disable-next-line typescript/no-explicit-any -- baseDatatypes stores schemas of heterogeneous types; per-name strict typing is recovered by `Datatype.SchemaFor` at the consumer.
type LazySchema = () => Schema.Schema<any, any, never>

/**
 * Lazy lookup from FHIR R4 datatype name to the fhir-r4 wire-format schema
 * registered for it. Primitive slots are seeded from emr-core's
 * `Datatype.baseSchemas` table — the references live here so the package can
 * later swap individual primitives to FHIR-wire-specific variants (e.g.
 * `date` as `YYYY-MM-DD`) without coupling to emr-core.
 *
 * Complex slots start as `undefined`. Each complex datatype module calls
 * {@link registerDatatypeSchema} at its bottom to install its wire schema.
 * A slot that remains `undefined` at decode/encode time will throw via
 * {@link resolveDatatypeSchema} — that's the deliberate-coupling posture:
 * unregistered datatypes never silently passthrough.
 */
const baseDatatypes: Record<Name, LazySchema | undefined> = {
  boolean: () => Datatype.baseSchemas.boolean,
  canonical: () => Datatype.baseSchemas.canonical,
  date: () => Datatype.baseSchemas.date,
  dateTime: () => Datatype.baseSchemas.dateTime,
  decimal: () => Datatype.baseSchemas.decimal,
  id: () => Datatype.baseSchemas.id,
  integer: () => Datatype.baseSchemas.integer,
  string: () => Datatype.baseSchemas.string,
  time: () => Datatype.baseSchemas.time,
  uri: () => Datatype.baseSchemas.uri,
  url: () => Datatype.baseSchemas.url,
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
  Reference: undefined,
}

/**
 * Register a fhir-r4 wire-format schema in the lazy lookup. Each complex
 * datatype module calls this once at the bottom of its file with its FHIR
 * datatype name and wire-format Effect Schema.
 */
const registerDatatypeSchema = (
  name: Name,
  // oxlint-disable-next-line typescript/no-explicit-any -- registry stores heterogeneous schemas; A and I are not load-bearing here.
  schema: Schema.Schema<any, any, never>
): void => {
  baseDatatypes[name] = () => schema
}

/**
 * Resolve a registered datatype's schema. Throws if `name` has no registered
 * thunk — that signals a `registeredNames` manifest entry whose module never
 * loaded (or never called `registerDatatypeSchema`).
 */
// oxlint-disable-next-line typescript/no-explicit-any -- mirrors LazySchema's return shape.
const resolveDatatypeSchema = (name: Name): Schema.Schema<any, any, never> => {
  const thunk = baseDatatypes[name]
  if (thunk === undefined) {
    throw new Error(
      `fhir-r4 datatype "${name}" is in registeredNames but no schema is registered. ` +
        `Ensure the module that owns this datatype has loaded before decoding/encoding through value[x].`
    )
  }
  return thunk()
}

export { baseDatatypes, registeredNames, registerDatatypeSchema, resolveDatatypeSchema, type Name }
