export {
  authorizeOpenServer,
  authorizeSmartLaunch,
  readySmartClient,
  shouldCompleteSmartLaunch,
  type OpenServerConfig,
  type SmartLaunchConfig,
} from './smart-launch.ts'

export {
  detectSmartSupport,
  normalizeServerUrl,
  startStandaloneLaunch,
  type SmartSupport,
  type StandaloneLaunchConfig,
} from './standalone-launch.ts'

export {
  RESOURCE_PAGE_SIZE,
  fetchResourcePage,
  type PagedResourceRead,
  type ResourcePage,
  type ResourcePageCursor,
} from './resource-page.ts'

export {
  fetchMedicationRequestPage,
  type MedicationRequestCursor,
  type MedicationRequestPage,
  type MedicationRequestResource,
} from './medication-requests.ts'

export {
  fetchObservationPage,
  type ObservationPage,
  type ObservationPageCursor,
  type ObservationResource,
} from './observations.ts'

export {
  fetchPatient,
  fetchPatientPage,
  type PatientPage,
  type PatientPageCursor,
  type PatientResource,
} from './patients.ts'

export {
  buildSmartQueryClient,
  buildSmartRouterContext,
  smartHttpClientLayer,
  type SmartSession,
} from './self-hosted-runtime.ts'

export { useSmartHandshake, type SmartHandshake } from './use-smart-handshake.ts'
