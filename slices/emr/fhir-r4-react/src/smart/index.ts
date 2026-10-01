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
  appLaunchUrl,
  SMART_LAUNCHER_HOST,
  smartLauncherEhrIssuer,
  smartLauncherLaunchCode,
  type AppLaunchServer,
} from './app-launch-url.ts'

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
  fetchObservationBasedOnOrPartOfPage,
  fetchObservationPage,
  type ObservationBasedOnOrPartOfFirstPage,
  type ObservationBasedOnOrPartOfPageCursor,
  type ObservationPage,
  type ObservationPageCursor,
  type ObservationResource,
} from './observations.ts'

export {
  fetchPlanDefinitionPage,
  type PlanDefinitionFirstPage,
  type PlanDefinitionPage,
  type PlanDefinitionPageCursor,
  type PlanDefinitionResource,
} from './plan-definitions.ts'

export {
  fetchProcedurePage,
  type ProcedureFirstPage,
  type ProcedurePage,
  type ProcedurePageCursor,
  type ProcedureResource,
} from './procedures.ts'

export {
  fetchActiveServiceRequestPage,
  type ServiceRequestFirstPage,
  type ServiceRequestPage,
  type ServiceRequestPageCursor,
  type ServiceRequestResource,
} from './service-requests.ts'

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
  type BuildSmartQueryClientOptions,
  type SmartSession,
} from './self-hosted-runtime.ts'

export {
  isSmartHandshakeQuery,
  useLaunchFailureRedirect,
  useSmartHandshake,
  whenSmartHandshakeReady,
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
