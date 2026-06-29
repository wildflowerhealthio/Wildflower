/**
 * The *scope context* — a view-model convenience with no `scopes-rust`
 * counterpart. A scope context groups the resource scopes the grid/consent views
 * edit together: a FHIR {@link Fhir.ContextLevel} (patient/user/system), or the
 * Wildflower admin kind. It is how the UI *addresses* a row over the faithful
 * {@link Scope} model — one scope context maps 1:1 to a grid section.
 *
 * Namespace module (`import { ScopeContext } from 'scopes-core'`): the context is
 * {@link ScopeContext}, with `ScopeContext.fhir`, `ScopeContext.makeResource`,
 * `ScopeContext.code`, …
 */

import type { Scope } from '../domain/index.ts'
import { AccessRights, Fhir, Wildflower } from '../domain/index.ts'

/** A group of resource scopes edited together: a FHIR context, or Wildflower admin. */
type ScopeContext =
  | { readonly kind: 'fhir'; readonly context: Fhir.ContextLevel }
  | { readonly kind: 'wildflower' }

/** A FHIR scope context for a context level. */
const fhir = (context: Fhir.ContextLevel): ScopeContext => ({ kind: 'fhir', context })

/** The Wildflower admin scope context. */
const wildflower: ScopeContext = { kind: 'wildflower' }

/** Whether a resource scope belongs to a scope context. */
const contains = (scopeContext: ScopeContext, scope: Scope.Resource): boolean =>
  scopeContext.kind === 'fhir'
    ? scope.kind === 'fhir' && scope.context === scopeContext.context
    : scope.kind === 'wildflower'

/** The scope context a resource scope belongs to. */
const of = (scope: Scope.Resource): ScopeContext =>
  scope.kind === 'fhir' ? fhir(scope.context) : wildflower

/** The context prefix of a scope context (`patient`/`user`/`system`/`wildflower`). */
const prefix = (scopeContext: ScopeContext): string =>
  scopeContext.kind === 'fhir' ? scopeContext.context : Wildflower.CONTEXT

/**
 * Build a {@link Scope.Resource} in a scope context from a resource name +
 * access, or `null` if the name isn't a valid resource for that context (the
 * Wildflower set is closed).
 */
const makeResource = (
  scopeContext: ScopeContext,
  name: string,
  access: AccessRights.AccessRights
): Scope.Resource | null => {
  if (scopeContext.kind === 'fhir') {
    return {
      kind: 'fhir',
      context: scopeContext.context,
      resource: Fhir.resourceType(name),
      access,
    }
  }
  const resource = Wildflower.resourceType(name)
  return resource === null ? null : { kind: 'wildflower', resource, access }
}

/** The live scope string for a (scope context, resource, access) — for grid `code` display. */
const code = (
  scopeContext: ScopeContext,
  name: string,
  access: AccessRights.AccessRights
): string => {
  const perms = AccessRights.scopeSerialize(access)
  return perms === ''
    ? `${prefix(scopeContext)}/${name}`
    : `${prefix(scopeContext)}/${name}.${perms}`
}

export { type ScopeContext, fhir, wildflower, contains, of, prefix, makeResource, code }
