import { Equal } from 'effect'
import type * as Contexts from './contexts'
import type * as Permission from './permission'
import type * as ResourceType from './resource-type'

abstract class BaseScope {
  abstract readonly kind: string

  abstract serialize(): string | null
}

abstract class BaseResourceScope<
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
  TContext extends Contexts.Context,
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
  TResource extends ResourceType.Base,
  TInteraction extends string,
> extends BaseScope {
  abstract readonly kind: string
  abstract readonly context: TContext
  abstract readonly resource: TResource
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
   * Whether this scope *covers* a (context, resource, interaction) cell (`spec.md §3`):
   * its context is a superset ({@link Contexts.Context.supersetOf} — `system ⊇ user ⊇
   * patient`), its resource is a superset ({@link ResourceType.Base.supersetOf} — `*`
   * ⊇ any known sibling), and its permission `has` the interaction. Same-style — `has`
   * is false across styles, so nothing cross-style false-covers. A read-side predicate
   * (`interaction` degrades to `string` at the boundary, like {@link BasePermission.has},
   * so it reads on the `Cruds | ReadWrite` union without collapsing); the fold over a
   * partition and the wildcard *lock* live in `ScopeConfiguration.scopesGrantInteraction`.
   */
  includesInteraction(
    context: Contexts.Context,
    resource: ResourceType.Base,
    interaction: string
  ): boolean {
    return (
      this.context.supersetOf(context) &&
      this.resource.supersetOf(resource) &&
      this.permission.has(interaction)
    )
  }

  static components(s: string): { context: string; resource: string; permissions: string } | null {
    const slash = s.indexOf('/')
    if (slash <= 0) return null

    const rest = s.slice(slash + 1)
    const dot = rest.lastIndexOf('.')
    if (dot <= 0) return null
    const context = s.slice(0, slash)

    const resource = rest.slice(0, dot)
    const permissions = rest.slice(dot + 1)
    return { context, resource, permissions } as const
  }
}

export { BaseScope, BaseResourceScope }
