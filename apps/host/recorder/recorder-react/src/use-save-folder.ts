import {
  type InvokeHostCommand,
  readSaveFolder,
  type SaveFolder,
} from '@wildflowerhealthio/recorder-core-js'
import { Effect } from 'effect'
import { useEffect, useState } from 'react'

/** The recordings folder, as the page shows it. */
type SaveFolderState =
  | { readonly _tag: 'Reading' }
  | { readonly _tag: 'Read'; readonly folder: SaveFolder }
  /** The host has no folder, or its answer didn't decode; `message` says why. */
  | { readonly _tag: 'Unreadable'; readonly message: string }

/**
 * Read the recordings folder from the host once, when the page mounts.
 *
 * @param invoke - Tauri's `invoke`
 */
const useSaveFolder = (invoke: InvokeHostCommand): SaveFolderState => {
  const [state, setState] = useState<SaveFolderState>({ _tag: 'Reading' })
  useEffect(() => {
    let unmounted = false
    void Effect.runPromise(
      readSaveFolder(invoke).pipe(
        Effect.match({
          onSuccess: (folder): SaveFolderState => ({ _tag: 'Read', folder }),
          onFailure: ({ message }): SaveFolderState => ({ _tag: 'Unreadable', message }),
        })
      )
    ).then((read) => {
      if (!unmounted) setState(read)
    })
    return () => {
      unmounted = true
    }
  }, [invoke])
  return state
}

export { useSaveFolder }
export type { SaveFolderState }
