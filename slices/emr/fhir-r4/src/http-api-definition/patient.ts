import {
  buildDomainResourceHttpApiGroup,
  buildEverythingEndpoint,
} from '../internal/domain-resource-http-api-definition.ts'
import { Patient } from '../resources/patient/index.ts'
import { SearchParams as PatientSearchParams } from '../resources/patient/search-params.ts'

// Patient is the one resource with `$everything`: the server implements the
// operation for Patient only (emr-rust's `patient_everything` override; HFS
// itself ships none).
const httpApiGroup = buildDomainResourceHttpApiGroup(
  'Patient',
  Patient.Schema,
  PatientSearchParams
).add(buildEverythingEndpoint('Patient'))

export { httpApiGroup }
