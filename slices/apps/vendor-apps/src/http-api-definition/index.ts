import { HttpApi } from '@effect/platform'
import * as PatientBrowser from './patient-browser.ts'

const VendorAppsApi = HttpApi.make('VendorAppsApi').add(PatientBrowser.httpApiGroup)

export { VendorAppsApi, PatientBrowser }
