import type { Schema } from 'effect'

import { PermissivePassthrough } from 'kitchen-sink/schema'

import * as Datatype from './datatype.ts'

// ---------------------------------------------------------------------------
// Lazy registry
// ---------------------------------------------------------------------------

/**
 * Entry in {@link baseDatatypes}. The `schema` thunk is resolved lazily so the
 * registry can be imported by `choice-element-set` without forcing a
 * module-init cycle through the complex datatypes that depend on
 * `Element` / `Extension`.
 */
interface LazyDatatype<Name extends Datatype.Name = Datatype.Name> {
  readonly name: Name
  // oxlint-disable-next-line typescript/no-explicit-any -- baseDatatypes stores schemas of heterogeneous types; the per-entry strict type is recovered by `Datatype.SchemaFor` in ChoiceElementSet.SchemaFields.
  readonly schema: () => Schema.Schema<any, any, never>
}

/**
 * Lookup table from FHIR R4 data type name to its lazy schema thunk.
 *
 * Initialised with {@link PermissivePassthrough} fallbacks for every name in
 * {@link Datatype.names}; strict primitives from `baseSchemas` are
 * pre-registered, and complex datatypes overwrite their slot via
 * {@link registerDatatypeSchema} at the bottom of their own module.
 */
const initialEntry = <Name extends Datatype.Name>(name: Name): LazyDatatype<Name> => {
  const schema =
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- baseSchemas keys are strict Datatype.Name; widening to string lets us index by an arbitrary Name without a per-name conditional.
    (Datatype.baseSchemas as unknown as Record<string, Schema.Schema<unknown> | undefined>)[name]
  if (schema !== undefined) return { name, schema: () => schema }
  return { name, schema: () => PermissivePassthrough }
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.fromEntries widens to Record<string, LazyDatatype>; the per-key LazyDatatype<K> shape is recovered by construction over Datatype.names.
const baseDatatypes = Object.fromEntries(
  Datatype.names.map((name) => [name, initialEntry(name)] as const)
) as unknown as { [K in Datatype.Name]: LazyDatatype<K> }

/**
 * Register a complex datatype's schema in the lazy lookup. Complex modules
 * call this at the bottom of their own file with their FHIR data type name
 * and Effect Schema.
 */
const registerDatatypeSchema = (
  name: Datatype.Name,
  // oxlint-disable-next-line typescript/no-explicit-any -- registry stores heterogeneous schemas; A and I are not load-bearing here.
  schema: Schema.Schema<any, any, never>
): void => {
  const writable = baseDatatypes as Record<Datatype.Name, LazyDatatype>
  writable[name] = { name, schema: () => schema }
}

export { baseDatatypes, registerDatatypeSchema }
