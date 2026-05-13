import { type HttpApiGroup, HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import { VendorAppsApi } from '../http-api-definition/index.ts'
import * as PatientBrowser from './patient-browser.ts'

const VendorAppsApiHandlersLive = Layer.mergeAll(PatientBrowser.layer)

const VendorAppsApiLive = HttpApiBuilder.api(VendorAppsApi).pipe(
  Layer.provide(VendorAppsApiHandlersLive)
)

type VendorAppsGroupNames = 'patient-browser'

const VendorAppsApiHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, VendorAppsGroupNames>,
  never,
  never
> =>
  // See gatekeeper-core's AuthApiHandlersFor: the phantom-id bridge lets a
  // Layer built against VendorAppsApi satisfy a parent ApiId's group requirement.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  VendorAppsApiHandlersLive as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, VendorAppsGroupNames>,
    never,
    never
  >

export { VendorAppsApi, VendorAppsApiHandlersLive, VendorAppsApiHandlersFor, VendorAppsApiLive }
