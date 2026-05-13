import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'

// The handler is registered via `handleRaw` and writes its own per-asset
// `content-type` header (text/html, application/javascript, image/*, fonts,
// ...), so we cannot pin the success schema to a single content type.
// `HttpApiSchema.Uint8Array()` describes the wire shape as raw bytes without
// claiming a specific MIME type; `handleRaw` bypasses encoding anyway.
const httpApiGroup = HttpApiGroup.make('patient-browser', { topLevel: false }).add(
  HttpApiEndpoint.get('GetPatientBrowserAsset', '/installed-apps/patient-browser/*').addSuccess(
    HttpApiSchema.Uint8Array()
  )
)

export { httpApiGroup }
