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
  BundleDecodeError,
  RESOURCE_PAGE_SIZE,
  ResourcePageRequestError,
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
  fetchDocumentReferencePage,
  type DocumentReferenceFirstPage,
  type DocumentReferencePage,
  type DocumentReferencePageCursor,
  type DocumentReferenceResource,
} from './document-references.ts'

export {
  buildSmartQueryClient,
  buildSmartRouterContext,
  smartHttpClientLayer,
  type SmartSession,
} from './self-hosted-runtime.ts'

export {
  useLaunchFailureRedirect,
  useSmartHandshake,
  type SmartHandshake,
} from './use-smart-handshake.ts'

export {
  FALLBACK_LAUNCH_MESSAGE,
  LAUNCH_ERROR_MESSAGES,
  LAUNCH_ERROR_PARAM,
  decodeLaunchError,
  encodeLaunchError,
  launchError,
  launchErrorBodyFor,
  launchErrorFrom,
  launchErrorRedirect,
  type LaunchErrorBody,
} from './launch-error.ts'
