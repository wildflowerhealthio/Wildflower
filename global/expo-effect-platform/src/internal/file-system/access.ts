import { type FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import { inspect, systemError } from './helpers.ts'

const access: FileSystem.FileSystem['access'] = (path, _options) =>
  Effect.flatMap(inspect('access', path), (info) =>
    info.exists ? Effect.void : Effect.fail(systemError('access', path, 'NotFound', null))
  )

export { access }
