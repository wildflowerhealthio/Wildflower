export {
  appRootRedirectUri,
  authorizeOpenServer,
  authorizeSmartLaunch,
  readySmartClient,
  shouldCompleteSmartLaunch,
  type OpenServerConfig,
  type SmartLaunchConfig,
} from './smart-launch.ts'

export {
  detectSmartSupport,
  insecureTargetReason,
  normalizeServerUrl,
  startStandaloneLaunch,
  type SmartSupport,
  type StandaloneLaunchConfig,
} from './standalone-launch.ts'

export { withLocalNetworkAccessHint } from './local-network-hint.ts'

export {
  BundleDecodeError,
  RESOURCE_PAGE_SIZE,
  ResourcePageCycleError,
  ResourcePageRequestError,
  fetchAllResourcePages,
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
  fetchObservationBasedOnPage,
  fetchObservationPage,
  type ObservationBasedOnFirstPage,
  type ObservationBasedOnPageCursor,
  type ObservationPage,
  type ObservationPageCursor,
  type ObservationResource,
} from './observations.ts'

export {
  fetchCarePlanPage,
  type CarePlanFirstPage,
  type CarePlanPage,
  type CarePlanPageCursor,
  type CarePlanResource,
} from './care-plans.ts'

export { fetchGoalPage, type GoalPage, type GoalPageCursor, type GoalResource } from './goals.ts'

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
