import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { Goal } from '../resources/goal/index.ts'
import { SearchParams as GoalSearchParams } from '../resources/goal/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup('Goal', Goal.Schema, GoalSearchParams)

export { httpApiGroup }
