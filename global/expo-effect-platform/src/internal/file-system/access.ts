import type * as FileSystem from '@effect/platform/FileSystem'
import * as Effect from 'effect/Effect'
import { inspect, systemError } from './helpers.ts'

const access: FileSystem.FileSystem['access'] = (path, _options) =>
  Effect.flatMap(inspect('access', path), (info) =>
    info.exists ? Effect.void : Effect.fail(systemError('access', path, 'NotFound', null))
  )

export { access }
