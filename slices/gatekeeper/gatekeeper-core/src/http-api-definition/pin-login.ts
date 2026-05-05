import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import { Schema } from 'effect'

const PinStatusSchema = Schema.Union(
  Schema.Struct({ status: Schema.Literal('pending') }),
  Schema.Struct({ status: Schema.Literal('declined') }),
  Schema.Struct({ status: Schema.Literal('expired') }),
  Schema.Struct({ status: Schema.Literal('approved'), redirect: Schema.String }),
  Schema.Struct({ status: Schema.Literal('error'), message: Schema.String })
)

const httpApiGroup = HttpApiGroup.make('pin-login', { topLevel: false })
  .add(
    HttpApiEndpoint.get('PinPage', '/pin').addSuccess(
      HttpApiSchema.Text({ contentType: 'text/html; charset=utf-8' })
    )
  )
  .add(
    HttpApiEndpoint.get('PinStatus', '/pin/:id')
      .setPath(Schema.Struct({ id: Schema.String }))
      .addSuccess(PinStatusSchema)
  )
  .add(
    HttpApiEndpoint.get('PinComplete', '/pin/:id/complete').setPath(
      Schema.Struct({ id: Schema.String })
    )
  )
  .prefix('/login')

export { httpApiGroup }
