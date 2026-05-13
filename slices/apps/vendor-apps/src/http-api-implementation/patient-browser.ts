import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { Effect } from 'effect'
import { VendorAppsApi } from '../http-api-definition/index.ts'
import { lookupAsset, PREFIX } from '../patient-browser.ts'

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const SHORT_CACHE_CONTROL = 'public, max-age=60, must-revalidate'

/**
 * Patient-browser assets are inlined at build time, so the fingerprinted
 * bundles under `assets/`, `img/`, fonts, etc. can be cached aggressively for
 * a year (`immutable`). `index.html` and the `config/*` JSON files act as
 * entry points / rotation points: a redeploy might swap which fingerprinted
 * assets they reference, so we keep them on a short `max-age` with
 * revalidation so clients pick up new deploys quickly without hammering the
 * server on every request.
 *
 * `assetPath` is the request pathname with the mount `PREFIX` already
 * stripped (matching the same normalization `lookupAsset` performs).
 */
const cacheControlFor = (assetPath: string): string => {
  if (assetPath === '' || assetPath.endsWith('/') || assetPath === 'index.html') {
    return SHORT_CACHE_CONTROL
  }
  if (assetPath.startsWith('config/')) return SHORT_CACHE_CONTROL
  return IMMUTABLE_CACHE_CONTROL
}

const layer = HttpApiBuilder.group(VendorAppsApi, 'patient-browser', (handlers) =>
  handlers.handleRaw('GetPatientBrowserAsset', () =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      const pathname = new URL(req.url, 'http://localhost').pathname
      const asset = lookupAsset(pathname)
      if (asset === undefined) {
        return HttpServerResponse.text('Not found', { status: 404 })
      }
      const assetPath = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : pathname
      return HttpServerResponse.uint8Array(Buffer.from(asset.base64, 'base64'), {
        headers: {
          'content-type': asset.contentType,
          'cache-control': cacheControlFor(assetPath),
        },
      })
    })
  )
)

export { layer }
