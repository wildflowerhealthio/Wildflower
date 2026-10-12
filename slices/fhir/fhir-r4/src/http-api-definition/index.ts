// oxlint-disable import/max-dependencies -- the API is one group per resource type, each its own module
import { HttpApi, type HttpApiError } from '@effect/platform'
import * as Binary from './binary.ts'
import * as Bundle from './bundle.ts'
import * as CarePlan from './care-plan.ts'
import * as DiagnosticReport from './diagnostic-report.ts'
import * as DocumentReference from './document-reference.ts'
import * as Goal from './goal.ts'
import * as ImagingStudy from './imaging-study.ts'
import * as MedicationDispense from './medication-dispense.ts'
import * as MedicationRequest from './medication-request.ts'
import * as Observation from './observation.ts'
import * as Patient from './patient.ts'
import * as PlanDefinition from './plan-definition.ts'
import * as Practitioner from './practitioner.ts'
import * as Procedure from './procedure.ts'
import * as ServiceRequest from './service-request.ts'

const FhirResourcesApi: HttpApi.HttpApi<
  'FhirResourcesApi',
  | typeof Patient.httpApiGroup
  | typeof Binary.httpApiGroup
  | typeof Observation.httpApiGroup
  | typeof MedicationRequest.httpApiGroup
  | typeof MedicationDispense.httpApiGroup
  | typeof DocumentReference.httpApiGroup
  | typeof DiagnosticReport.httpApiGroup
  | typeof Practitioner.httpApiGroup
  | typeof ServiceRequest.httpApiGroup
  | typeof ImagingStudy.httpApiGroup
  | typeof CarePlan.httpApiGroup
  | typeof Goal.httpApiGroup
  | typeof PlanDefinition.httpApiGroup
  | typeof Procedure.httpApiGroup
  | typeof Bundle.httpApiGroup,
  HttpApiError.HttpApiDecodeError
> = HttpApi.make('FhirResourcesApi')
  .add(Patient.httpApiGroup)
  .add(Binary.httpApiGroup)
  .add(Observation.httpApiGroup)
  .add(MedicationRequest.httpApiGroup)
  .add(MedicationDispense.httpApiGroup)
  .add(DocumentReference.httpApiGroup)
  .add(DiagnosticReport.httpApiGroup)
  .add(Practitioner.httpApiGroup)
  .add(ServiceRequest.httpApiGroup)
  .add(ImagingStudy.httpApiGroup)
  .add(CarePlan.httpApiGroup)
  .add(Goal.httpApiGroup)
  .add(PlanDefinition.httpApiGroup)
  .add(Procedure.httpApiGroup)
  .add(Bundle.httpApiGroup)

export {
  FhirResourcesApi,
  Binary,
  Bundle,
  CarePlan,
  DiagnosticReport,
  DocumentReference,
  Goal,
  ImagingStudy,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
  PlanDefinition,
  Practitioner,
  Procedure,
  ServiceRequest,
}
