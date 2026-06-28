/**
 * The *bucket* — a view-model convenience with no `scopes-rust` counterpart. A
 * bucket groups the resource scopes the grid/consent views edit together: a FHIR
 * {@link Fhir.ContextLevel}, or the Wildflower admin kind. It is how the UI
 * *addresses* a row over the faithful {@link Scope} model.
 *
 * Namespace module (`import { Bucket } from 'scopes-core'`): the bucket is
 * {@link Any}, with `Bucket.fhir`, `Bucket.makeResource`, `Bucket.code`, …
 */

import type { Scope } from '../domain/index.ts'
import { AccessRights, Fhir, Wildflower } from '../domain/index.ts'

/** A group of resource scopes edited together: a FHIR context, or Wildflower admin. */
export type Any =
  | { readonly kind: 'fhir'; readonly context: Fhir.ContextLevel }
  | { readonly kind: 'wildflower' }

/** A FHIR bucket for a context level. */
export const fhir = (context: Fhir.ContextLevel): Any => ({ kind: 'fhir', context })

/** The Wildflower admin bucket. */
export const wildflower: Any = { kind: 'wildflower' }

/** Whether a resource scope belongs to a bucket. */
export const contains = (bucket: Any, scope: Scope.Resource): boolean =>
  bucket.kind === 'fhir'
    ? scope.kind === 'fhir' && scope.context === bucket.context
    : scope.kind === 'wildflower'

/** The bucket a resource scope belongs to. */
export const of = (scope: Scope.Resource): Any =>
  scope.kind === 'fhir' ? fhir(scope.context) : wildflower

/** The context prefix of a bucket (`patient`/`user`/`system`/`wildflower`). */
export const prefix = (bucket: Any): string =>
  bucket.kind === 'fhir' ? bucket.context : Wildflower.CONTEXT

/**
 * Build a {@link Scope.Resource} in a bucket from a resource name + access, or
 * `null` if the name isn't a valid resource for that bucket (the Wildflower set
 * is closed).
 */
export const makeResource = (
  bucket: Any,
  name: string,
  access: AccessRights.Any
): Scope.Resource | null => {
  if (bucket.kind === 'fhir') {
    return { kind: 'fhir', context: bucket.context, resource: Fhir.resourceType(name), access }
  }
  const resource = Wildflower.resourceType(name)
  return resource === null ? null : { kind: 'wildflower', resource, access }
}

/** The live scope string for a (bucket, resource, access) — for grid `code` display. */
export const code = (bucket: Any, name: string, access: AccessRights.Any): string => {
  const perms = AccessRights.serialize(access)
  return perms === '' ? `${prefix(bucket)}/${name}` : `${prefix(bucket)}/${name}.${perms}`
}
