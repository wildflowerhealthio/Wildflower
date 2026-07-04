/** SMART on FHIR v1 scope grammar: `context/Type.read|write|*` (readWrite permission style). */

import * as Contexts from './contexts'
import type * as Permission from './permission'
import ReadWritePermission from './permission/read-write-permission.ts'
import * as ResourceType from './resource-type'
import { ScopeConfiguration } from './scope-configuration.ts'
import { BaseResourceScope } from './scope.ts'

class FhirV1ResourceScope extends BaseResourceScope<
  Contexts.Fhir,
  ResourceType.Fhir,
  ReadWritePermission.Interaction,
  'fhirV1'
> {
  readonly kind = 'fhirV1' as const
  readonly context: Contexts.Fhir
  readonly resource: ResourceType.Fhir
  readonly permission: Permission.Base<ReadWritePermission.Interaction>

  /** The construction recipe for this variant (`spec.md §5` — passed to editors). */
  static readonly configuration = new ScopeConfiguration<
    Contexts.Fhir,
    ResourceType.Fhir,
    ReadWritePermission.Interaction,
    'fhirV1',
    FhirV1ResourceScope
  >({
    id: 'fhirV1',
    permissionClass: ReadWritePermission,
    resourceClass: ResourceType.Fhir,
    contextClass: Contexts.Fhir,
    is: (scope) => scope instanceof FhirV1ResourceScope,
    select: (ms) => ms.fhirV1,
    make: (context, resource, permission) => new FhirV1ResourceScope(context, resource, permission),
  })

  constructor(
    context: Contexts.Fhir,
    resource: ResourceType.Fhir,
    permission: Permission.Base<ReadWritePermission.Interaction>
  ) {
    super()
    this.context = context
    this.resource = resource
    this.permission = permission
  }

  withPermission(permission: ReadWritePermission): FhirV1ResourceScope {
    return new FhirV1ResourceScope(this.context, this.resource, permission)
  }
}

export default FhirV1ResourceScope
