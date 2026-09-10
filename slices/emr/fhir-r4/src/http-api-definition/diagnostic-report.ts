import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { DiagnosticReport } from '../resources/diagnostic-report/index.ts'
import { SearchParams as DiagnosticReportSearchParams } from '../resources/diagnostic-report/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup(
  'DiagnosticReport',
  DiagnosticReport.Schema,
  DiagnosticReportSearchParams
)

export { httpApiGroup }
