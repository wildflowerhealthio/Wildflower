/**
 * The `wildflower/Resource.perms` admin resource scope and its parts, mirroring
 * `scopes-rust`'s `WildflowerResource` / `WildflowerResourceScope` /
 * `WildflowerResourceType` (`scope/resource/wildflower.rs`). These resources are
 * **not** reachable through the FHIR `*` wildcard — the set is closed.
 *
 * Wildflower permissions are {@link CrudsPermissionStyle} permissions only — the
 * SMART v1 word forms (`read`/`write`/`*`) are FHIR-only, so `wildflower/Grant.read`
 * does not parse (it falls back to {@link UnknownScope}).
 *
 * Namespace module (`import { Wildflower } from 'scopes-core'`): the scope value
 * is {@link WildflowerResourceScope}, with `Wildflower.scopeParse`, `Wildflower.Resource`, …
 */
import * as Contexts from './contexts'
import * as Permission from './permission'
import * as ResourceType from './resource-type'
import { ScopeConfiguration } from './scope-configuration.ts'
import { BaseResourceScope } from './scope.ts'

class WildflowerResourceScope extends BaseResourceScope<
  Contexts.Wildflower,
  ResourceType.Wildflower,
  Permission.Cruds.Interaction
> {
  readonly kind = 'wildflower' as const
  readonly context: Contexts.Wildflower
  readonly resource: ResourceType.Wildflower
  readonly permission: Permission.Base<Permission.Cruds.Interaction>

  /** The construction recipe for this variant (`spec.md §5` — passed to editors). */
  static readonly configuration = new ScopeConfiguration<
    Contexts.Wildflower,
    ResourceType.Wildflower,
    Permission.Cruds.Interaction,
    WildflowerResourceScope
  >({
    id: 'wildflower',
    emptyPermission: Permission.Cruds.empty,
    is: (scope) => scope instanceof WildflowerResourceScope,
    parseResource: ResourceType.Wildflower.parse,
    select: (ms) => ms.wildflower,
    make: (context, resource, permission) =>
      new WildflowerResourceScope(context, resource, permission),
  })

  constructor(
    context: Contexts.Wildflower,
    resource: ResourceType.Wildflower,
    permission: Permission.Base<Permission.Cruds.Interaction>
  ) {
    super()
    this.context = context
    this.resource = resource
    this.permission = permission
  }

  get configuration(): ScopeConfiguration<
    Contexts.Wildflower,
    ResourceType.Wildflower,
    Permission.Cruds.Interaction,
    WildflowerResourceScope
  > {
    return WildflowerResourceScope.configuration
  }

  withPermission(
    permission: Permission.Base<Permission.Cruds.Interaction>
  ): WildflowerResourceScope {
    return WildflowerResourceScope.configuration.make(this.context, this.resource, permission)
  }

  static parse(s: string): WildflowerResourceScope | null {
    const parts = BaseResourceScope.components(s)
    if (parts === null) return null

    const context = Contexts.Wildflower.parse(parts.context)
    if (context === null) return null

    const resource = ResourceType.Wildflower.parse(parts.resource)
    if (resource === null) return null

    const permission = Permission.Cruds.parse(parts.permissions)
    if (permission === null) return null

    return new WildflowerResourceScope(context, resource, permission)
  }
}

export default WildflowerResourceScope
