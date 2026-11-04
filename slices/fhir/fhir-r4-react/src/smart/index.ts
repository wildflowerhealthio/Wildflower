export {
  appRootRedirectUri,
  arrivingSmartLaunchFrom,
  CallbackStateMismatch,
  completeSignInAfterRedirectHere,
  discardRefusedSignInAfterRedirectHere,
  NoSignInInProgress,
  redirectToSelfAddressedSignInReturn,
  redirectToSignIn,
  redirectToSignInAt,
  SMART_LAUNCH_PARAMS,
  type ArrivingSmartLaunch,
  type SelfAddressedSignInConfig,
  type SignInAfterRedirectError,
  type SignInLanding,
  type SmartLaunchConfig,
  type SmartRegistration,
} from './smart-launch.ts'

export {
  detectSmartSupport,
  insecureTargetReason,
  normalizeServerUrl,
  redirectToPickedServerSignIn,
  SmartSupport,
} from './standalone-launch.ts'

export { RootArrival, rootArrivalFrom, type SignInArrival } from './root-arrival.ts'

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
  fetchServiceRequestPage,
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
  smartRuntimeFor,
  type BuildSmartQueryClientOptions,
  type RunSmart,
  type SmartRouterContext,
  type SmartRuntime,
  type SmartRuntimeLayer,
  type SmartServices,
} from './smart-runtime.ts'

export { SmartRuntimeContext, useRunSmart } from './use-run-smart.ts'

export { decodeFhirBaseUrl, FhirBaseUrl, SmartConnection } from './smart-connection.ts'

export {
  isSmartHandshakeQuery,
  useRedirectToRootOnFailure,
  useSmartHandshake,
  SmartHandshake,
} from './use-smart-handshake.ts'

export {
  FhirHttpError,
  FhirRequestDropped,
  FhirResponseNotJson,
  SmartClient,
  type FhirRequestError,
} from './smart-client.ts'

export {
  FALLBACK_LAUNCH_MESSAGE,
  LAUNCH_ERROR_MESSAGES,
  LAUNCH_ERROR_PARAM,
  decodeLaunchError,
  encodeLaunchError,
  launchError,
  launchErrorBodyFor,
  launchErrorRedirect,
  type LaunchErrorBody,
} from './launch-error.ts'
