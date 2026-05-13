import { type BundledApp, makeAppId } from './app-item.ts'

const FHIR_SHARING_ID = makeAppId('fhir-sharing')
const PATIENT_BROWSER_ID = makeAppId('patient-browser')

const BUNDLED_APPS: readonly BundledApp[] = [
  {
    id: FHIR_SHARING_ID,
    name: 'FHIR Sharing',
    subtitle: 'Open this device to FHIR requests from other apps.',
    kind: 'action',
    requiresTunnel: true,
    url: (origin) => origin,
  },
  {
    id: PATIENT_BROWSER_ID,
    name: 'Patient Browser',
    subtitle: 'Browse patient records served from this device.',
    kind: 'bundled',
    requiresTunnel: false,
    url: (origin) => `${origin}/apps/patient-browser/index.html`,
  },
  {
    id: makeAppId('api-view'),
    name: 'API View',
    subtitle: 'View patient records in your browser.',
    kind: 'bundled',
    requiresTunnel: false,
    url: (origin) => `${origin}/fhir-r4/Patient/8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882`,
  },
  {
    id: makeAppId('api-docs'),
    name: 'API Docs',
    subtitle: 'View API documentation in your browser.',
    kind: 'bundled',
    requiresTunnel: false,
    url: (origin) => `${origin}/docs`,
  },
  {
    id: makeAppId('growth-chart'),
    name: 'Growth Chart',
    subtitle: 'Interactive growth chart app.',
    kind: 'bundled',
    requiresTunnel: true,
    url: (origin, launch) =>
      `https://examples.smarthealthit.org/growth-chart-app/launch.html?iss=${origin}/fhir-r4&launch=${launch}`,
  },
  {
    id: makeAppId('medication-viewer'),
    name: 'Medication Viewer',
    subtitle: 'A bare medication viewer app.',
    kind: 'bundled',
    requiresTunnel: true,
    url: (origin, launch) =>
      `https://mitre.github.io/smart-on-fhir-demo/launch.html?iss=${origin}/fhir-r4&launch=${launch}`,
  },
]

const findBundled = (id: string): BundledApp | undefined =>
  BUNDLED_APPS.find((app) => app.id === id)

export { BUNDLED_APPS, FHIR_SHARING_ID, PATIENT_BROWSER_ID, findBundled }
