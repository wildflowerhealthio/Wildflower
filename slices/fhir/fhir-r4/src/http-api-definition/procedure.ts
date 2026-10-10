import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { Procedure } from '../resources/procedure/index.ts'
import { SearchParams as ProcedureSearchParams } from '../resources/procedure/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup(
  'Procedure',
  Procedure.Schema,
  ProcedureSearchParams
)

export { httpApiGroup }
