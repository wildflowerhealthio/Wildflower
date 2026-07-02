/** SMART on FHIR v2 scope grammar: `context/Type.cruds` (cruds letter-bag style). */

import * as Contexts from './contexts'
import * as Permission from './permission'
import * as ResourceType from './resource-type'
import { ScopeConfiguration } from './scope-configuration.ts'
import { BaseResourceScope } from './scope.ts'

class FhirV2ResourceScope extends BaseResourceScope<
  Contexts.Fhir,
  ResourceType.Fhir,
  Permission.Cruds.Interaction,
  'fhirV2'
> {
  readonly kind = 'fhirV2' as const
  readonly context: Contexts.Fhir
  readonly resource: ResourceType.Fhir
  readonly permission: Permission.Base<Permission.Cruds.Interaction>

  /** The construction recipe for this variant (`spec.md §5` — passed to editors). */
  static readonly configuration = new ScopeConfiguration<
    Contexts.Fhir,
    ResourceType.Fhir,
    Permission.Cruds.Interaction,
    'fhirV2'
  >({
    id: 'fhirV2',
    emptyPermission: Permission.Cruds.empty,
    is: (scope) => scope instanceof FhirV2ResourceScope,
    parseResource: ResourceType.Fhir.parse,
    select: (ms) => ms.fhirV2,
    make: (context, resource, permission) => new FhirV2ResourceScope(context, resource, permission),
  })

  constructor(
    context: Contexts.Fhir,
    resource: ResourceType.Fhir,
    permission: Permission.Base<Permission.Cruds.Interaction>
  ) {
    super()
    this.context = context
    this.resource = resource
    this.permission = permission
  }

  get configuration(): ScopeConfiguration<
    Contexts.Fhir,
    ResourceType.Fhir,
    Permission.Cruds.Interaction,
    'fhirV2'
  > {
    return FhirV2ResourceScope.configuration
  }

  withPermission(permission: Permission.Cruds): FhirV2ResourceScope {
    return new FhirV2ResourceScope(this.context, this.resource, permission)
  }

  static parse(s: string): FhirV2ResourceScope | null {
    const parts = BaseResourceScope.components(s)
    if (parts === null) return null

    const context = Contexts.Fhir.parse(parts.context)
    if (context === null) return null

    const resource = ResourceType.Fhir.parse(parts.resource)
    if (resource === null) return null

    const permission = Permission.Cruds.parse(parts.permissions)
    if (permission === null) return null

    return new FhirV2ResourceScope(context, resource, permission)
  }
}

export default FhirV2ResourceScope
