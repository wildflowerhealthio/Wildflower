import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { MedicationDispense } from '../resources/medication-dispense/index.ts'
import { SearchParams as MedicationDispenseSearchParams } from '../resources/medication-dispense/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup(
  'MedicationDispense',
  MedicationDispense.Schema,
  MedicationDispenseSearchParams
)

export { httpApiGroup }
