import { buildDomainResourceHttpApiGroup } from '../internal/domain-resource-http-api-definition.ts'
import { Patient } from '../resources/patient/index.ts'
import { SearchParams as PatientSearchParams } from '../resources/patient/search-params.ts'

const httpApiGroup = buildDomainResourceHttpApiGroup('Patient', Patient.Schema, PatientSearchParams)

export { httpApiGroup }
