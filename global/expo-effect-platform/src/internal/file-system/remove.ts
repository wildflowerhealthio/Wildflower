import { type FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import { Directory, File } from 'expo-file-system'
import { fileUri, inspect, systemError, trySystem } from './helpers.ts'

const remove: FileSystem.FileSystem['remove'] = (path, options) =>
  Effect.flatMap(inspect('remove', path), (info) => {
    if (!info.exists) {
      return options?.force === true
        ? Effect.void
        : Effect.fail(systemError('remove', path, 'NotFound', null))
    }
    return trySystem('remove', path, 'Unknown', () => {
      const uri = fileUri(path)
      if (info.isDirectory === true) {
        // expo-file-system's `Directory.delete()` removes the directory and
        // all contents, matching the Effect contract when `recursive: true`.
        new Directory(uri).delete()
      } else {
        new File(uri).delete()
      }
    })
  })

export { remove }
