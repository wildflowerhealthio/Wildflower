export {
  buildFhirR4ResourcesClientLayer,
  type FhirR4ResourcesClientRequirements,
} from './client/fhir-r4-resources-client.ts'

export * as FhirR4ResourcesRouterContext from './router-context.ts'

export { useFhirR4ResourcesRuntimeLayer } from './router-context.ts'

export {
  patientQueryKey,
  patientQueryOptions,
  patientsQueryOptions,
  PATIENTS_QUERY_KEY,
  usePatientQuery,
  usePatientsQuery,
  useRunAuthed,
  type PatientResource,
  type RunAuthed,
} from './queries/index.ts'
