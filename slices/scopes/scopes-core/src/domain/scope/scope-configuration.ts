/**
 * The {@link ScopeConfiguration} — the construction recipe for one *concrete*
 * resource-scope variant, plus the **partition operations** parameterized by it:
 * resolution (`spec.md §3`), editing, and serialization. A recipe is a *value* (held
 * as `Variant.configuration`) so callers pass it rather than branching on
 * `context.kind × permission.kind`. Its methods fold over a {@link MultiScope}: each
 * pulls its own partition via the typed {@link select} field, keyed by the partition
 * literal {@link id} (`'fhirV1' | 'fhirV2' | 'wildflower'`). The variant's element type
 * is recovered as {@link VariantScope} — `Extract<AnyScope, { kind: TId }>` viewed
 * through its {@link BaseResourceScope} facet — so every method reads on a single
 * `Permission.Base<TInteraction>` with no `Cruds | ReadWrite` union to collapse, while
 * `select` / `make` / `toggleItem` still return the *concrete* partition element that
 * flows back into `grant[id]`. The TS core owns this algebra — `scopes-rust` has none.
 *
 * Namespace + type combo (`import { Scope } from 'scopes-core'` → `Scope.ScopeConfiguration`).
 */

import { Equal } from 'effect'

import type * as Contexts from './contexts'
import type { MultiScope } from './multi-scope.ts'
import type * as Permission from './permission'
import type * as ResourceType from './resource-type'
import { BaseResourceScope, type BaseScope } from './scope.ts'

/**
 * The construction recipe for one *concrete* resource-scope variant, keyed to its
 * partition literal `TId` so every part is variant-precise: `id` is that literal, `make`
 * returns a `BaseResourceScope<…, TId>` (so it flows back into a `grant[id]` partition),
 * {@link is} narrows a flat list to the variant, and {@link select} pulls this variant's
 * partition out of a {@link MultiScope} (typed `readonly BaseResourceScope<…, TId>[]`).
 * Keying the permission to a single `TInteraction` means the edit ops read on
 * `Permission.Base<TInteraction>` directly — never the `Cruds | ReadWrite` union, so
 * nothing collapses.
 */
class ScopeConfiguration<
  TContext extends Contexts.Context,
  TResourceType extends ResourceType.Base,
  TInteraction extends string,
  TId extends string,
> {
  readonly id: TId
  readonly emptyPermission: Permission.Base<TInteraction>
  readonly is: (
    scope: BaseScope
  ) => scope is BaseResourceScope<TContext, TResourceType, TInteraction, TId>
  readonly parseResource: (name: string) => TResourceType | null
  readonly select: (
    ms: MultiScope
  ) => readonly BaseResourceScope<TContext, TResourceType, TInteraction, TId>[]
  readonly make: (
    context: TContext,
    resource: TResourceType,
    permission: Permission.Base<TInteraction>
  ) => BaseResourceScope<TContext, TResourceType, TInteraction, TId>

  constructor(recipe: ScopeConfiguration.Recipe<TContext, TResourceType, TInteraction, TId>) {
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
   * {@link scopesGrantInteraction}); a row emptied by the toggle is dropped.
   *
   * `Grant.make` groups only by `.kind`, so a split list (`patient/Observation.r` +
   * `patient/Observation.s`) can leave several rows for one (context, resource). Their
   * permissions are *merged* before toggling — otherwise every matching row but the last
   * is dropped, disagreeing with {@link serialize}, which folds the same duplicates. The
   * merge is read on `emptyPermission.make`, so `permission` never widens to the
   * `Cruds | ReadWrite` union.
   */
  toggleItem(
    owned: readonly BaseResourceScope<TContext, TResourceType, TInteraction, TId>[],
    context: TContext,
    resource: TResourceType,
    itemId: TInteraction
  ): readonly BaseResourceScope<TContext, TResourceType, TInteraction, TId>[] {
    if (
      !ScopeConfiguration.scopesGrantInteraction<TContext, TResourceType, TInteraction>(
        owned,
        context,
        resource,
        itemId
      ).grantedAtOwnResource
    )
      return owned

    const owns = (scope: BaseResourceScope<TContext, TResourceType, TInteraction, TId>): boolean =>
      scope.hasContext(context) && scope.hasResource(resource)

    const merged = this.emptyPermission.make(
      owned.filter(owns).flatMap((scope) => scope.permission.toArray())
    )
    const next = merged.toggle(itemId)

    const others = owned.filter((scope) => !owns(scope))
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
      // §3 dedupe: the interactions a strictly-broader same-context scope (a `*` wildcard
      // row) already grants — computed once as a single covering permission, then subtracted,
      // rather than re-folding the whole partition per interaction.
      const covered = this.emptyPermission.make(
        owned
          .filter(
            (other) =>
              other !== scope &&
              Equal.equals(other.context, scope.context) &&
              !Equal.equals(other.resource, scope.resource) &&
              other.resource.supersetOf(scope.resource)
          )
          .flatMap((other) => other.permission.toArray())
      )
      const remainder = this.emptyPermission.make(
        scope.permission.toArray().filter((interaction) => !covered.has(interaction))
      )
      const serialized = this.make(scope.context, scope.resource, remainder).serialize()
      if (serialized !== null && serialized !== '') out.push(serialized)
    }
    return out
  }

  /**
   * This variant's partition of `grant`, entirely within `allowed`'s (`spec.md §2`): every
   * interaction of every granted row is covered by *some* `allowed` scope — via the same
   * superset test as coverage/lock ({@link scopesGrantInteraction} → {@link isSupersetOf}),
   * so a wildcard `allowed` row (`patient/*.rs`) authorizes the concrete rows beneath it
   * rather than requiring an exact `(context, resource)` match. `grant` and `allowed` are
   * both {@link MultiScope}s.
   */
  within(grant: MultiScope, allowed: MultiScope): boolean {
    const allowedPartition = this.select(allowed)
    return this.select(grant).every((scope) =>
      scope.permission
        .toArray()
        .every(
          (interaction) =>
            ScopeConfiguration.scopesGrantInteraction<TContext, TResourceType, TInteraction>(
              allowedPartition,
              scope.context,
              scope.resource,
              interaction
            ).granted
        )
    )
  }

  /**
   * Parse a `context/Type.perms` string into a resource scope, or `null` if any segment
   * fails — the shared skeleton behind every variant's `parse` ({@link BaseResourceScope.components}
   * → context → resource → permission → `make`). Each variant supplies its own segment parsers
   * and concrete constructor, so `TScope` is inferred from `make` and the return stays that
   * variant's *concrete* scope (no base-view erasure). Static: reads without a recipe instance.
   */
  static parse<
    TContext extends Contexts.Context,
    TResourceType extends ResourceType.Base,
    TInteraction extends string,
    TScope,
  >(
    s: string,
    parseContext: (segment: string) => TContext | null,
    parseResource: (segment: string) => TResourceType | null,
    parsePermission: (segment: string) => Permission.Base<TInteraction> | null,
    make: (
      context: TContext,
      resource: TResourceType,
      permission: Permission.Base<TInteraction>
    ) => TScope
  ): TScope | null {
    const parts = BaseResourceScope.components(s)
    if (parts === null) return null

    const context = parseContext(parts.context)
    if (context === null) return null

    const resource = parseResource(parts.resource)
    if (resource === null) return null

    const permission = parsePermission(parts.permissions)
    if (permission === null) return null

    return make(context, resource, permission)
  }

  /**
   * Resolve one interaction cell against a homogeneous partition `owned` (`spec.md §3`),
   * folding every scope whose {@link isSupersetOf} covers it (context **hierarchical** —
   * `system ⊇ user ⊇ patient` — resource superset-aware). A cover at a *different resource*
   * can only be a `*` wildcard row (a named resource covers only its exact self), which
   * clears `grantedAtOwnResource` — the cell is granted but wildcard-locked. Static: no
   * recipe is needed to read.
   */
  static scopesGrantInteraction<
    TContext extends Contexts.Context,
    TResourceType extends ResourceType.Base,
    TInteraction extends string,
  >(
    owned: readonly BaseResourceScope<TContext, TResourceType, TInteraction>[],
    context: TContext,
    resource: TResourceType,
    interaction: TInteraction
  ): ScopeConfiguration.InteractionGrantedness {
    let granted = false
    let grantedAtOwnResource = true
    for (const scope of owned) {
      if (!scope.isSupersetOf(context, resource, interaction)) continue
      granted = true
      // A cover at a different resource can only be a `*` wildcard row (a named resource
      // covers only its exact self), whatever its context — that is the wildcard lock.
      if (!Equal.equals(scope.resource, resource)) grantedAtOwnResource = false
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
    TId extends string,
  > = {
    readonly id: TId
    readonly emptyPermission: Permission.Base<TInteraction>
    readonly is: (
      scope: BaseScope
    ) => scope is BaseResourceScope<TContext, TResourceType, TInteraction, TId>
    readonly parseResource: (name: string) => TResourceType | null
    readonly select: (
      ms: MultiScope
    ) => readonly BaseResourceScope<TContext, TResourceType, TInteraction, TId>[]
    readonly make: (
      context: TContext,
      resource: TResourceType,
      permission: Permission.Base<TInteraction>
    ) => BaseResourceScope<TContext, TResourceType, TInteraction, TId>
  }

  /** How a partition grants one (context, resource, interaction) cell (`spec.md §3`). */
  export type InteractionGrantedness = {
    /** Some scope in the partition covers this cell. */
    readonly granted: boolean
    /**
     * No *strictly-broader* scope covers it — so it lives on its own row and is
     * independently editable. `false` ⇒ a same-context `*` wildcard scope covers it,
     * i.e. wildcard-locked (`spec.md §3`).
     */
    readonly grantedAtOwnResource: boolean
  }
}

export { ScopeConfiguration }
