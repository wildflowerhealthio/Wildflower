export {
  authorizeOpenServer,
  authorizeSmartLaunch,
  readySmartClient,
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

export { fetchMedicationRequests, type MedicationRequestResource } from './medication-requests.ts'

export {
  buildSmartRouterContext,
  smartHttpClientLayer,
  type SmartSession,
} from './self-hosted-runtime.ts'
