import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { VendorAppsApi } from '../http-api-definition/index.ts'
import { lookupAsset } from '../patient-browser.ts'

const layer = HttpApiBuilder.group(VendorAppsApi, 'patient-browser', (handlers) =>
  handlers.handleRaw('GetPatientBrowserAsset', () =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const pathname = new URL(req.url, 'http://localhost').pathname
      const asset = lookupAsset(pathname)
      if (asset === undefined) {
        return HttpServerResponse.text('Not found', { status: 404 })
      }
      return HttpServerResponse.uint8Array(Buffer.from(asset.base64, 'base64'), {
        headers: { 'content-type': asset.contentType },
      })
    })
  )
)

export { layer }
