import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'

const httpApiGroup = HttpApiGroup.make('patient-browser', { topLevel: false }).add(
  HttpApiEndpoint.get('GetPatientBrowserAsset', '/apps/patient-browser/*').addSuccess(
    HttpApiSchema.Text({ contentType: 'application/octet-stream' })
  )
)

export { httpApiGroup }
