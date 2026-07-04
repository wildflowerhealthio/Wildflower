/** SMART on FHIR v1 scope grammar: `context/Type.read|write|*` (readWrite permission style). */

import * as Contexts from './contexts'
import * as Permission from './permission'
import * as ResourceType from './resource-type'
import { ScopeConfiguration } from './scope-configuration.ts'
import type { BaseResourceScope } from './scope-configuration.ts'

const FhirV1ResourceScopeConfiguration = new ScopeConfiguration<
  Contexts.Fhir,
  ResourceType.Fhir,
  Permission.ReadWrite.Interaction,
  'fhirV1'
>({
  id: 'fhirV1',
  permissionClass: Permission.ReadWrite,
  resourceClass: ResourceType.Fhir,
  contextClass: Contexts.Fhir,
})

const FhirV1ResourceScope = FhirV1ResourceScopeConfiguration.Instance

type FhirV1ResourceScope = BaseResourceScope<
  Contexts.Fhir,
  ResourceType.Fhir,
  Permission.ReadWrite.Interaction,
  'fhirV1'
>

export default FhirV1ResourceScope
