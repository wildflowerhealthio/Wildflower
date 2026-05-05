import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

import { FhirPublicApi } from '../http-api-definition/index.ts'
import { SmartConfiguration } from '../internal/smart-configuration-context.ts'

const layer = HttpApiBuilder.group(FhirPublicApi, 'smart-well-known', (handlers) =>
  handlers.handle('SmartConfiguration', () =>
    Effect.gen(function* () {
      return yield* SmartConfiguration
    })
  )
)

export { layer }
