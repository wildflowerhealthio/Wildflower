/** SMART on FHIR v2 scope grammar: `context/Type.cruds` (cruds letter-bag style). */

import * as Contexts from './contexts'
import * as Permission from './permission'
import { ResourceScopeConfiguration } from './resource-scope-configuration.ts'
import { type BaseResourceScope } from './resource-scope-configuration.ts'
import * as ResourceType from './resource-type'

const FhirV2ResourceScopeConfiguration = new ResourceScopeConfiguration<
  Contexts.Fhir,
  ResourceType.Fhir,
  Permission.Cruds.Interaction,
  'fhirV2'
>({
  id: 'fhirV2',
  permissionClass: Permission.Cruds,
  resourceClass: ResourceType.Fhir,
  contextClass: Contexts.Fhir,
})

const FhirV2ResourceScope = FhirV2ResourceScopeConfiguration.Instance

type FhirV2ResourceScope = BaseResourceScope<
  Contexts.Fhir,
  ResourceType.Fhir,
  Permission.Cruds.Interaction,
  'fhirV2'
>

export default FhirV2ResourceScope
