import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { PlanDefinition } from '../resources/plan-definition/index.ts'
import { SearchParams as PlanDefinitionSearchParams } from '../resources/plan-definition/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup(
  'PlanDefinition',
  PlanDefinition.Schema,
  PlanDefinitionSearchParams
)

export { httpApiGroup }
