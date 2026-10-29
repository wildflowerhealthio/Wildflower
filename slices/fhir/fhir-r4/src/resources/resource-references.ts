/**
 * Every `Reference` a decoded resource carries, at any depth, each at its
 * path: found by `fhir-r4`'s own `Reference` schema rather than a list of
 * field names, so a reference anywhere in a resource is reached.
 *
 * @packageDocumentation
 */

import { Schema } from 'effect'

import {
  ReferenceSchema,
  type ReferenceType as Reference,
} from '../data-types/complex/identifier-and-reference.ts'
import type { FhirResource } from './fhir-resource.ts'

/** Whether `value` is a record the decode built — not a `URL` or any other class instance. */
const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const isReferenceSchema = Schema.is(Schema.typeSchema(ReferenceSchema))

/**
 * Whether a decoded record is a `Reference`, as `fhir-r4`'s schema decides.
 * The key test only spares the schema check on the records that cannot be one.
 */
const isReference = (value: unknown): value is Reference =>
  isPlainRecord(value) && 'reference' in value && isReferenceSchema(value)

/**
 * A `Reference` at its path in the resource: `subject`, `performer[1]`,
 * `performer[0].actor`, `contained[0].subject`. Fields are joined with `.`,
 * array elements indexed with `[n]`.
 */
interface ReferenceAt {
  readonly path: string
  readonly reference: Reference
}

const fieldPath = (parent: string, key: string): string =>
  parent.length === 0 ? key : `${parent}.${key}`

/**
 * `value` with `rewrite` applied to every decoded `Reference` in it, each
 * with its path under `path`. Records and arrays nothing changed in come back
 * as themselves.
 */
const mapIn = (
  value: unknown,
  path: string,
  rewrite: (reference: Reference, path: string) => Reference
): unknown => {
  if (Array.isArray(value)) {
    const elements: readonly unknown[] = value
    const mapped = elements.map((element, index) => mapIn(element, `${path}[${index}]`, rewrite))
    return mapped.every((element, index) => element === elements[index]) ? value : mapped
  }
  if (!isPlainRecord(value)) return value
  const visited = isReference(value) ? rewrite(value, path) : value
  const fields = Object.entries(visited)
  const mapped = fields.map(
    ([key, field]) => [key, mapIn(field, fieldPath(path, key), rewrite)] as const
  )
  const unchanged =
    visited === value && mapped.every(([, field], index) => field === fields[index]?.[1])
  return unchanged ? value : Object.fromEntries(mapped)
}

/**
 * `resource` with `rewrite` applied to every `Reference` it carries, at any
 * depth.
 *
 * @remarks
 * The walk rebuilds only the records and arrays something changed in, and
 * replaces a `Reference` only with what `rewrite` returns for it, so the
 * result has `resource`'s own shape, and a resource nothing changed in comes
 * back as itself. The type system cannot follow a walk over every field,
 * hence the one assertion; the property tests pin the shape.
 */
const mapReferences = <TResource extends FhirResource>(
  resource: TResource,
  rewrite: (reference: Reference) => Reference
): TResource =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the walk keeps the shape; see @remarks
  mapIn(resource, '', rewrite) as TResource

/** Every `Reference` `resource` carries, at any depth, at its path, each before the references nested in it. */
const collect = (resource: FhirResource): readonly ReferenceAt[] => {
  const found: ReferenceAt[] = []
  mapIn(resource, '', (reference, path) => {
    found.push({ path, reference })
    return reference
  })
  return found
}

export { collect, mapReferences }
export type { ReferenceAt }
