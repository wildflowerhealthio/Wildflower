import { type FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import { File } from 'expo-file-system'
import * as Telemetry from '../../telemetry.ts'
import { fileUri, inspect, instrument, systemError, trySystem } from './helpers.ts'

const readFile: FileSystem.FileSystem['readFile'] = (path) =>
  Effect.flatMap(inspect('readFile', path), (info) => {
    if (!info.exists) return Effect.fail(systemError('readFile', path, 'NotFound', null))
    return trySystem('readFile', path, 'Unknown', () => new File(fileUri(path)).bytesSync())
  }).pipe(instrument('readFile', Telemetry.FileSystem.ReadFile.Span.Name, path))

export { readFile }
