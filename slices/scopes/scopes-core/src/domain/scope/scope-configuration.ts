/**
 * The {@link ScopeConfiguration} — the construction recipe for one *concrete*
 * resource-scope variant, plus the **partition operations** parameterized by it:
 * resolution (`spec.md §3`), editing, and serialization. A recipe is a *value* (held
 * as `Variant.configuration`) so callers pass it rather than branching on
 * `context.kind × permission.kind`. Its methods fold over a {@link MultiScope}: each
 * pulls its own partition via the typed {@link select} field (`S` is fixed per
 * instance, so the partition types as `readonly S[]` with no cast — sidestepping the
 * correlated-union limit a generic registry fold would hit). The TS core owns this
 * algebra — `scopes-rust` has no counterpart.
 *
 * Namespace + type combo (`import { Scope } from 'scopes-core'` → `Scope.ScopeConfiguration`).
 */

import { Equal } from 'effect'

import type * as Contexts from './contexts'
import type FhirV1 from './fhir-scope-v1.ts'
import type FhirV2 from './fhir-scope-v2.ts'
import type { MultiScope } from './multi-scope.ts'
import type * as Permission from './permission'
import type * as ResourceType from './resource-type'
import type { BaseScope, BaseResourceScope } from './scope.ts'
import type Wildflower from './wildflower-scope.ts'

/** Any concrete resource-scope variant — the homogeneous element of a partition. */
type AnyScope = FhirV1 | FhirV2 | Wildflower

/**
 * The construction recipe for one *concrete* resource-scope variant, keyed to that
 * variant `TScope` so every part is variant-precise: `id` is its `kind`, `make` returns
 * the concrete scope (so it flows back into a `grant.<kind>` partition), {@link is}
 * narrows a flat list to `TScope[]`, and {@link select} pulls this variant's partition
 * out of a {@link MultiScope} (typed `readonly TScope[]`). Keying the permission to a
 * single `TInteraction` means the edit ops read on `Permission.Base<TInteraction>`
 * directly — never the `Cruds | ReadWrite` union, so nothing collapses.
 */
class ScopeConfiguration<
  TContext extends Contexts.Context,
  TResourceType extends ResourceType.Base,
  TInteraction extends string,
  TScope extends AnyScope & BaseResourceScope<TContext, TResourceType, TInteraction>,
> {
  readonly id: TScope['kind']
  readonly emptyPermission: Permission.Base<TInteraction>
  readonly is: (scope: BaseScope) => scope is TScope
  readonly parseResource: (name: string) => TResourceType | null
  readonly select: (
    ms: MultiScope
  ) => readonly (TScope & BaseResourceScope<TContext, TResourceType, TInteraction>)[]
  readonly make: (
    context: TContext,
    resource: TResourceType,
    permission: Permission.Base<TInteraction>
  ) => TScope & BaseResourceScope<TContext, TResourceType, TInteraction>

  constructor(recipe: ScopeConfiguration.Recipe<TContext, TResourceType, TInteraction, TScope>) {
    this.id = recipe.id
    this.emptyPermission = recipe.emptyPermission
    this.is = recipe.is
    this.parseResource = recipe.parseResource
    this.select = recipe.select
    this.make = recipe.make
  }

  /**
   * Toggle one interaction on a (context, resource) row within this variant's
   * homogeneous partition `owned`, returning the NEW partition. A no-op when a
   * strictly-broader scope already covers the control (`spec.md §3`, self-guarded via
   * {@link scopesGrantInteraction}); a row emptied by the toggle is dropped. The row's
   * permission is read on the `for…of` loop variable, so `TScope['permission']` never
   * widens to the `Cruds | ReadWrite` union.
   */
  toggleItem(
    owned: readonly (TScope & BaseResourceScope<TContext, TResourceType, TInteraction>)[],
    context: TContext,
    resource: TResourceType,
    itemId: TInteraction
  ): readonly (TScope & BaseResourceScope<TContext, TResourceType, TInteraction>)[] {
    if (
      !ScopeConfiguration.scopesGrantInteraction<TContext, TResourceType, TInteraction>(
        owned,
        context,
        resource,
        itemId
      ).grantedAtOwnResource
    )
      return owned

    let next = this.emptyPermission.toggle(itemId)
    for (const scope of owned) {
      if (scope.hasContext(context) && scope.hasResource(resource)) {
        next = scope.permission.toggle(itemId)
      }
    }

    const others = owned.filter(
      (scope) => !(scope.hasContext(context) && scope.hasResource(resource))
    )
    return next.isEmpty() ? others : [...others, this.make(context, resource, next)]
  }

  /**
   * This variant's partition of `ms`, serialized with `spec.md §3` dedupe: each row
   * drops every interaction a *strictly-broader* same-variant scope already grants (so
   * `patient/*.r` present ⇒ `patient/Observation.r` emits nothing for `r`), then
   * serializes; a row emptied by dedupe emits nothing. Order follows the partition.
   */
  serialize(ms: MultiScope): string[] {
    const owned = this.select(ms)
    const out: string[] = []
    for (const scope of owned) {
      const permission: Permission.Base<TInteraction> = scope.permission
      let remainder = permission
      for (const interaction of permission.toArray()) {
        if (
          !ScopeConfiguration.scopesGrantInteraction<TContext, TResourceType, TInteraction>(
            owned,
            scope.context,
            scope.resource,
            interaction
          ).grantedAtOwnResource
        ) {
          remainder = remainder.withoutInteraction(interaction)
        }
      }
      const serialized = this.make(scope.context, scope.resource, remainder).serialize()
      if (serialized !== null && serialized !== '') out.push(serialized)
    }
    return out
  }

  /**
   * This variant's partition of `grant`, entirely within `allowed`'s (`spec.md §2`): every
   * granted row has an `allowed` row for the same (context, resource) whose permission is a
   * superset (via the permission's own `subsetOf`); `grant` and `allowed` are both {@link MultiScope}s.
   */
  within(grant: MultiScope, allowed: MultiScope): boolean {
    const allowedPartition = this.select(allowed)
    return this.select(grant).every((scope) => {
      const row = allowedPartition.find(
        (candidate) => candidate.hasContext(scope.context) && candidate.hasResource(scope.resource)
      )
      return row !== undefined && scope.permission.subsetOf(row.permission)
    })
  }

  /**
   * Resolve one interaction cell against a homogeneous partition `owned` (`spec.md §3`),
   * folding every scope whose `includesInteraction` covers it. A strictly-broader scope
   * (a same-context wildcard, or a higher-context grant) clears `grantedAtOwnResource` —
   * the cell is granted but wildcard-locked. Static: no recipe is needed to read.
   */
  static scopesGrantInteraction<
    TContext extends Contexts.Context,
    TResourceType extends ResourceType.Base,
    TInteraction extends string,
  >(
    owned: readonly (AnyScope & BaseResourceScope<TContext, TResourceType, TInteraction>)[],
    context: TContext,
    resource: TResourceType,
    interaction: TInteraction
  ): ScopeConfiguration.InteractionGrantedness {
    let granted = false
    let grantedAtOwnResource = true
    for (const scope of owned) {
      if (!scope.includesInteraction(context, resource, interaction)) continue
      granted = true
      const exact = Equal.equals(scope.context, context) && Equal.equals(scope.resource, resource)
      if (!exact) grantedAtOwnResource = false
    }
    return { granted, grantedAtOwnResource }
  }
}

// oxlint-disable import/group-exports
namespace ScopeConfiguration {
  /** The plain-data recipe a {@link ScopeConfiguration} is constructed from. */
  export type Recipe<
    TContext extends Contexts.Context,
    TResourceType extends ResourceType.Base,
    TInteraction extends string,
    TScope extends AnyScope & BaseResourceScope<TContext, TResourceType, TInteraction>,
  > = {
    readonly id: TScope['kind']
    readonly emptyPermission: Permission.Base<TInteraction>
    readonly is: (scope: BaseScope) => scope is TScope
    readonly parseResource: (name: string) => TScope['resource'] | null
    readonly select: (ms: MultiScope) => readonly TScope[]
    readonly make: (
      context: TContext,
      resource: TResourceType,
      permission: Permission.Base<TInteraction>
    ) => TScope & BaseResourceScope<TContext, TResourceType, TInteraction>
  }

  /** The union of the three variant recipes. */
  export type Any = Wildflower['configuration'] | FhirV1['configuration'] | FhirV2['configuration']

  /** How a partition grants one (context, resource, interaction) cell (`spec.md §3`). */
  export type InteractionGrantedness = {
    /** Some scope in the partition covers this cell. */
    readonly granted: boolean
    /**
     * No *strictly-broader* scope covers it — so it lives on its own row and is
     * independently editable. `false` ⇒ a wildcard / higher-context scope covers it,
     * i.e. wildcard-locked (`spec.md §3`).
     */
    readonly grantedAtOwnResource: boolean
  }
}

export { ScopeConfiguration }
