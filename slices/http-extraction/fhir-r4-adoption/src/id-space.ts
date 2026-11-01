import { WILDFLOWER_IDENTIFIER_SYSTEM_BASE } from '@wildflowerhealthio/fhir-r4/data-types'
import { Schema as EffectSchema } from 'effect'

/**
 * An id space: the system a record's source id belongs to, as an absolute URI.
 *
 * @remarks
 * A record is keyed by (id space, resource type, source id). Its local id is
 * `localResourceId` of that key, and its source identifier is
 * `{ system: <id space>, value: <source id> }`, so the id space must be an
 * absolute URI that `new URL` accepts.
 *
 * - A FHIR server's id space for a type is `<base>/<Type>`
 *   (`https://example.com/fhir/Patient`): its ids are unique per type
 *   ({@link inFhirServer}).
 * - A portal's is its Wildflower-minted `…/fhir/sid/<source>` system, for
 *   every type ({@link inSystem}).
 * - A picked source file's is its format's coding system.
 * - A record its source gave no id is keyed by a digest of its content, in
 *   {@link CONTENT_DIGEST}.
 */
const Schema = EffectSchema.String.pipe(EffectSchema.brand('IdSpace'))

type Type = typeof Schema.Type

/**
 * Where a source keys its records of each type: the id space a record, or a
 * reference's target, of `resourceType` belongs to in that source.
 */
type OfType = (resourceType: string) => Type

/**
 * The id spaces of a FHIR server rooted at `base`: `<base>/<Type>` for each
 * type, worked out once per type.
 */
const inFhirServer = (base: string): OfType => {
  const byType = new Map<string, Type>()
  return (resourceType) => {
    const known = byType.get(resourceType)
    if (known !== undefined) {
      return known
    }
    const idSpace = Schema.make(`${base}/${resourceType}`)
    byType.set(resourceType, idSpace)
    return idSpace
  }
}

/** The id spaces of a source that keys every type in the one `system`. */
const inSystem = (system: string): OfType => {
  const idSpace = Schema.make(system)
  return () => idSpace
}

/**
 * The id space of a record its source gave no id, whose source id is a digest
 * of its content. Shared by every source, as Wildflower's other minted
 * identifier systems are; the digest itself is scoped to its source.
 */
const CONTENT_DIGEST: Type = Schema.make(`${WILDFLOWER_IDENTIFIER_SYSTEM_BASE}/content-digest`)

export { CONTENT_DIGEST, Schema, inFhirServer, inSystem }
export type { OfType, Type }
