import { type FileSystem } from '@effect/platform'
import { Effect } from 'effect'
import { File } from 'expo-file-system'
import { fileUri, systemError, trySystem } from './helpers.ts'

const writeFile: FileSystem.FileSystem['writeFile'] = (path, data, options) => {
  // `WriteFileOptions.flag` and `mode` are not honoured by `File.write`. A
  // caller asking for `'a'` (append) or `'wx'` (exclusive) would otherwise
  // silently get a clobbering truncate; fail loudly so the contract break
  // surfaces in the typed channel.
  if (options?.flag !== undefined && options.flag !== 'w') {
    return Effect.fail(
      systemError(
        'writeFile',
        path,
        'BadResource',
        new Error(`WriteFileOptions.flag=${options.flag} is not supported by expo-file-system`),
        `WriteFileOptions.flag=${options.flag} is not supported by expo-file-system`
      )
    )
  }
  return trySystem('writeFile', path, 'Unknown', () => {
    // `FileCreateOptions.overwrite: true` collapses the create-or-overwrite
    // path into a single native call, avoiding the TOCTOU window of a
    // delete-then-create dance.
    const file = new File(fileUri(path))
    file.create({ overwrite: true })
    file.write(data)
  })
}

export { writeFile }
