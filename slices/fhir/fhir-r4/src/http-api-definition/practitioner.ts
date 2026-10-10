import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { Practitioner } from '../resources/practitioner/index.ts'
import { SearchParams as PractitionerSearchParams } from '../resources/practitioner/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup(
  'Practitioner',
  Practitioner.Schema,
  PractitionerSearchParams
)

export { httpApiGroup }
