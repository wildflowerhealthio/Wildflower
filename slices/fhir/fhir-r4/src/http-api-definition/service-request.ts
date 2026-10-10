import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { ServiceRequest } from '../resources/service-request/index.ts'
import { SearchParams as ServiceRequestSearchParams } from '../resources/service-request/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup(
  'ServiceRequest',
  ServiceRequest.Schema,
  ServiceRequestSearchParams
)

export { httpApiGroup }
