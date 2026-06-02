import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { SmartConfigurationSchema } from '../internal/smart-configuration-context.ts'

const httpApiGroup = HttpApiGroup.make('smart-well-known', { topLevel: false })
  .add(
    HttpApiEndpoint.get('SmartConfiguration', '/smart-configuration').addSuccess(
      SmartConfigurationSchema
    )
  )
  .prefix('/.well-known')

export { httpApiGroup }
