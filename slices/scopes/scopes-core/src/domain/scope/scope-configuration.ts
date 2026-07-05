/**
 * The {@link ScopeConfiguration} — the construction recipe for one *concrete*
 * resource-scope variant, plus the **partition operations** parameterized by it:
 * resolution (`spec.md §3`), editing, and serialization. A recipe is a *value* (held
 * as `Variant.configuration`) so callers pass it rather than branching on
 * `context.kind × permission.kind`. Its methods fold over one partition of a
 * {@link MultiScope}, pulled by the caller via `MultiScope.partition(grant, id)` /
 * indexed access on the partition literal {@link id} (`'fhirV1' | 'fhirV2' | 'wildflower'`)
 * — so every method reads on a single `Permission.Base<TInteraction>`
 * with no `Cruds | ReadWrite` union to collapse, while `make` / `toggleItem` still
 * return the *concrete* partition element that flows back into `grant[id]`. The TS
 * core owns this algebra — `scopes-rust` has none.
 *
 * Namespace + type combo (`import { Scope } from 'scopes-core'` → `Scope.ScopeConfiguration`).
 */

import { Equal } from 'effect'

import type * as Contexts from './contexts'
import type * as Permission from './permission'
import type * as ResourceType from './resource-type'
import { BaseScope } from './scope.ts'

/**
 * The construction recipe for one *concrete* resource-scope variant, keyed to its
 * partition literal `TId` so every part is variant-precise: `id` is that literal and
 * `make` returns a `BaseResourceScope<…, TId>` (so it flows back into a `grant[id]`
 * partition, which callers pull via `MultiScope.partition`).
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
  // oxlint-disable typescript/no-explicit-any
  readonly permissionClass: {
    readonly empty: Permission.Base<TInteraction>
    readonly parse: (name: string) => Permission.Base<TInteraction> | null
  } & (abstract new (...args: any[]) => Permission.Base<TInteraction>)
  readonly resourceClass: {
    readonly parse: (name: string) => TResourceType | null
    /** The `*` wildcard resource singleton, when this variant has one (`spec.md §3/§4`). */
    readonly wildcardResourceType?: TResourceType
  } & (abstract new (...args: any[]) => TResourceType)
  readonly contextClass: {
    readonly parse: (name: string) => TContext | null
  } & (abstract new (...args: any[]) => TContext)

  make(
    context: TContext,
    resource: TResourceType,
    permission: Permission.Base<TInteraction>
  ): BaseResourceScope<TContext, TResourceType, TInteraction, TId> {
    return new this.Instance(context, resource, permission)
  }

  readonly Instance

  constructor(recipe: ScopeConfiguration.Recipe<TContext, TResourceType, TInteraction, TId>) {
    this.id = recipe.id
    this.permissionClass = recipe.permissionClass
    this.resourceClass = recipe.resourceClass
    this.contextClass = recipe.contextClass

    // oxlint-disable-next-line typescript/no-this-alias
    const scopeConfiguration = this
    this.Instance = class Instance extends (
      BaseResourceScope<TContext, TResourceType, TInteraction, TId>
    ) {
      kind: TId
      context: TContext
      resource: TResourceType
      permission: Permission.Base<TInteraction>

      constructor(
        context: TContext,
        resource: TResourceType,
        permission: Permission.Base<TInteraction>
      ) {
        super()
        this.kind = scopeConfiguration.id
        this.context = context
        this.resource = resource
        this.permission = permission
      }

      static readonly configuration: ScopeConfiguration<
        TContext,
        TResourceType,
        TInteraction,
        TId
      > = scopeConfiguration
    }
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
      !ScopeConfiguration.scopesGrantInteraction<TContext, TResourceType, TInteraction, TId>(
        owned,
        context,
        resource,
        itemId
      ).grantedAtOwnResource
    )
      return owned

    const owns = (scope: BaseResourceScope<TContext, TResourceType, TInteraction, TId>): boolean =>
      scope.hasContext(context) && scope.hasResource(resource)

    const merged = this.permissionClass.empty.make(
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
  serialize(
    owned: readonly BaseResourceScope<TContext, TResourceType, TInteraction, TId>[]
  ): string[] {
    const out: string[] = []
    for (const scope of owned) {
      // §3 dedupe: the interactions a strictly-broader scope already grants — a `*` wildcard
      // row whose context *covers* this one (`system` covers every context).
      // Computed once as a single covering permission, then subtracted via
      // `subtractCovered`, rather than re-folding the whole partition per interaction.
      // Matches `scopesGrantInteraction`'s lock rule (a cover clears
      // `grantedAtOwnResource` only when its resource differs — a wildcard).
      const covered = this.permissionClass.empty.make(
        owned
          .filter(
            (other) =>
              other !== scope &&
              other.context.covers(scope.context) &&
              !Equal.equals(other.resource, scope.resource) &&
              other.resource.supersetOf(scope.resource)
          )
          .flatMap((other) => other.permission.toArray())
      )
      const subtraction = scope.permission.subtractCovered(covered)
      if (subtraction.kind === 'covered') continue
      const emit =
        subtraction.kind === 'whole'
          ? scope
          : this.make(scope.context, scope.resource, subtraction.value)
      const serialized = emit.serialize()
      if (serialized !== null && serialized !== '') out.push(serialized)
    }
    return out
  }

  parse(s: string): BaseResourceScope<TContext, TResourceType, TInteraction, TId> | null {
    const parts = BaseResourceScope.components(s)
    if (parts === null) return null

    const context = this.contextClass.parse(parts.context)
    if (context === null) return null

    const resource = this.resourceClass.parse(parts.resource)
    if (resource === null) return null

    const permission = this.permissionClass.parse(parts.permissions)
    if (permission === null) return null

    return this.make(context, resource, permission)
  }

  /**
   * This variant's partition of `grant`, entirely within `allowed`'s (`spec.md §2`): every
   * interaction of every granted row is covered by *some* `allowed` scope — via the same
   * superset test as coverage/lock ({@link scopesGrantInteraction} → {@link isSupersetOf}),
   * so a wildcard `allowed` row (`patient/*.rs`) authorizes the concrete rows beneath it
   * rather than requiring an exact `(context, resource)` match. `grant` and `allowed` are
   * both {@link MultiScope}s.
   */
  within(
    grantPartition: readonly BaseResourceScope<TContext, TResourceType, TInteraction, TId>[],
    allowedPartition: readonly BaseResourceScope<TContext, TResourceType, TInteraction, TId>[]
  ): boolean {
    return grantPartition.every((scope) =>
      scope.permission
        .toArray()
        .every(
          (interaction) =>
            ScopeConfiguration.scopesGrantInteraction<TContext, TResourceType, TInteraction, TId>(
              allowedPartition,
              scope.context,
              scope.resource,
              interaction
            ).granted
        )
    )
  }

  /**
   * Resolve one interaction cell against a homogeneous partition `owned` (`spec.md §3`),
   * folding every scope whose {@link isSupersetOf} covers it (context coverage —
   * `system` covers every context — resource superset-aware). A cover at a *different resource*
   * can only be a `*` wildcard row (a named resource covers only its exact self), which
   * clears `grantedAtOwnResource` — the cell is granted but wildcard-locked. Static: no
   * recipe is needed to read.
   */
  static scopesGrantInteraction<
    TContext extends Contexts.Context,
    TResourceType extends ResourceType.Base,
    TInteraction extends string,
    TId extends string,
  >(
    owned: readonly BaseResourceScope<TContext, TResourceType, TInteraction, TId>[],
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
    readonly permissionClass: {
      readonly empty: Permission.Base<TInteraction>
      readonly parse: (name: string) => Permission.Base<TInteraction> | null
      // oxlint-disable typescript/no-explicit-any
    } & (abstract new (...args: any[]) => Permission.Base<TInteraction>)
    readonly resourceClass: {
      readonly parse: (name: string) => TResourceType | null
      /** The `*` wildcard resource singleton, when this variant has one (`spec.md §3/§4`). */
      readonly wildcardResourceType?: TResourceType
    } & (abstract new (...args: any[]) => TResourceType)
    readonly contextClass: {
      readonly parse: (name: string) => TContext | null
    } & (abstract new (...args: any[]) => TContext)
    // oxlint-enable typescript/no-explicit-any
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

abstract class BaseResourceScope<
  // oxlint-disable typescript/no-unnecessary-type-parameters
  TContext extends Contexts.Context,
  TResourceType extends ResourceType.Base,
  TInteraction extends string,
  TId extends string,
  // oxlint-enable typescript/no-unnecessary-type-parameters
> extends BaseScope {
  abstract readonly kind: TId
  abstract readonly context: TContext
  abstract readonly resource: TResourceType
  abstract readonly permission: Permission.Base<TInteraction>

  serialize(): string | null {
    const context = this.context.serialize()
    const resource = this.resource.serialize()
    const permission = this.permission.serialize()

    if (permission === null) return null

    return `${context}/${resource}.${permission}`
  }

  hasContext<UContext extends Contexts.Context>(context: UContext): this is { context: UContext } {
    return Equal.equals(this.context, context)
  }

  hasResource<UResource extends ResourceType.Base>(
    resource: UResource
  ): this is { resource: UResource } {
    return Equal.equals(this.resource, resource)
  }

  /**
   * Whether this scope is a superset of — i.e. *covers* — a (context, resource, interaction)
   * cell (`spec.md §3`; mirrors `scopes-rust`'s `FhirResourceScope::covers`): its context
   * covers the cell's ({@link Contexts.Context.covers} — for FHIR, `system` covers every
   * context), its resource is a superset ({@link ResourceType.Base.supersetOf} —
   * `*` ⊇ any known sibling), and its permission `has` the interaction. Same-style — `has`
   * is false across styles, so nothing cross-style false-covers. A read-side predicate
   * (`interaction` degrades to `string` at the boundary, like {@link BasePermission.has}, so
   * it reads on the `Cruds | ReadWrite` union without collapsing); the fold over a partition
   * and the wildcard *lock* live in `ScopeConfiguration.scopesGrantInteraction`.
   */
  isSupersetOf(
    context: Contexts.Context,
    resource: ResourceType.Base,
    interaction: string
  ): boolean {
    return (
      this.context.covers(context) &&
      this.resource.supersetOf(resource) &&
      this.permission.has(interaction)
    )
  }

  static components(s: string): { context: string; resource: string; permissions: string } | null {
    const slash = s.indexOf('/')
    if (slash <= 0) return null

    const context = s.slice(0, slash)
    const rest = s.slice(slash + 1)

    // Split type/perms on the FIRST dot (mirrors Rust's `rest.split_once('.')`).
    const dot = rest.indexOf('.')
    if (dot <= 0) return null

    const resource = rest.slice(0, dot)
    let permissions = rest.slice(dot + 1)

    // Drop a SMART v2 `?`-search-parameter suffix (mirrors Rust's `strip_search_suffix`).
    const question = permissions.indexOf('?')
    if (question >= 0) permissions = permissions.slice(0, question)

    // A second dot leaves the type/perms boundary ambiguous — invalid (falls to Unknown).
    if (permissions.includes('.')) return null

    return { context, resource, permissions } as const
  }
}

export { ScopeConfiguration, BaseResourceScope }
