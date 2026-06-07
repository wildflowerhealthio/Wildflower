import { type FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import * as Telemetry from '../../telemetry.ts'
import { inspect, instrument, systemError } from './helpers.ts'

const access: FileSystem.FileSystem['access'] = (path, _options) =>
  Effect.flatMap(inspect('access', path), (info) =>
    info.exists ? Effect.void : Effect.fail(systemError('access', path, 'NotFound', null))
  ).pipe(instrument('access', Telemetry.FileSystem.Access.Span.Name, path))

export { access }
