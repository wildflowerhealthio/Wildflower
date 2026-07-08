/**
 * The `wildflower/Resource.perms` admin resource scope and its parts, mirroring
 * `scopes-rust`'s `WildflowerResource` / `WildflowerResourceScope` /
 * `WildflowerResourceType` (`scope/resource/wildflower.rs`). These resources are
 * **not** reachable through the FHIR `*` wildcard — the set is closed.
 *
 * Wildflower permissions are {@link CrudsPermission} permissions only — the
 * SMART v1 word forms (`read`/`write`/`*`) are FHIR-only, so `wildflower/Grant.read`
 * does not parse (it falls back to {@link UnknownScope}).
 *
 * Namespace module (`import { Wildflower } from 'scopes-core'`): the scope value
 * is {@link WildflowerResourceScope}, with `Wildflower.scopeParse`, `Wildflower.Resource`, …
 */
import * as Contexts from './contexts'
import * as Permission from './permission'
import { ResourceScopeConfiguration } from './resource-scope-configuration.ts'
import type { BaseResourceScope } from './resource-scope-configuration.ts'
import * as ResourceType from './resource-type'

const WildflowerResourceScopeConfiguration = new ResourceScopeConfiguration<
  Contexts.Wildflower,
  ResourceType.Wildflower,
  Permission.Cruds.Interaction,
  'wildflower'
>({
  id: 'wildflower',
  permissionClass: Permission.Cruds,
  resourceClass: ResourceType.Wildflower,
  contextClass: Contexts.Wildflower,
})

const WildflowerResourceScope = WildflowerResourceScopeConfiguration.Instance

type WildflowerResourceScope = BaseResourceScope<
  Contexts.Wildflower,
  ResourceType.Wildflower,
  Permission.Cruds.Interaction,
  'wildflower'
>
export default WildflowerResourceScope
