import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { CarePlan } from '../resources/care-plan/index.ts'
import { SearchParams as CarePlanSearchParams } from '../resources/care-plan/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup(
  'CarePlan',
  CarePlan.Schema,
  CarePlanSearchParams
)

export { httpApiGroup }
