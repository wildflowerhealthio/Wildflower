import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { Schema } from 'effect'

const htmlResponse = HttpApiSchema.Text({ contentType: 'text/html; charset=utf-8' })

const httpApiGroup = HttpApiGroup.make('gatekeeper-web', { topLevel: false })
  .add(HttpApiEndpoint.get('GetAuthUi', '/ui').addSuccess(htmlResponse))
  .add(HttpApiEndpoint.get('GetAuthUiRequests', '/ui/requests').addSuccess(htmlResponse))
  .add(
    HttpApiEndpoint.get('GetAuthUiRequest', '/ui/requests/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(htmlResponse)
  )
  .add(
    HttpApiEndpoint.get('GetAuthUiApproved', '/ui/approved/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(htmlResponse)
  )
  .add(
    HttpApiEndpoint.get('GetAuthUiAuthorizationRequest', '/ui/authorization_request/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(htmlResponse)
  )
  .prefix('/auth')

const GatekeeperWebApi = HttpApi.make('GatekeeperWebApi').add(httpApiGroup)

export { GatekeeperWebApi, httpApiGroup }
