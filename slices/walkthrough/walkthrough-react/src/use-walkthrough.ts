import {
  readSeenWalkthrough,
  type WalkthroughOutcome,
  type WalkthroughStorage,
  writeSeenWalkthrough,
} from '@wildflowerhealthio/walkthrough-core'
import { useCallback, useState } from 'react'

/** Options for {@link useWalkthrough}. */
interface UseWalkthroughOptions {
  /** Where the record is kept: `window.localStorage` in an app. */
  readonly storage: WalkthroughStorage
  /** Which of the app's walkthroughs this is; names its record in `storage`. */
  readonly id: string
  /** The version of the walkthrough's steps; a record for another one shows it again. */
  readonly version: number
}

/** Whether a walkthrough should be showing, and how to move the visitor on. */
interface WalkthroughPrompt {
  /** No record for this version yet, or reopened, and not postponed since. */
  readonly open: boolean
  /** Record that the visitor went through every step, and close the walkthrough. */
  readonly finish: () => void
  /** Record that the visitor left before the last step, and close the walkthrough. */
  readonly skip: () => void
  /**
   * Close the walkthrough without recording anything, so it opens again the
   * next time the page mounts: for when it could not show.
   */
  readonly postpone: () => void
  /** Show the walkthrough again over a record already kept ("Show walkthrough again"). */
  readonly reopen: () => void
}

/** Whether walkthrough `id` at `version` is open; kept with the two it was decided for. */
interface OpenState {
  readonly id: string
  readonly version: number
  readonly open: boolean
}

/**
 * Whether the visitor has been through walkthrough `id`, read from `storage`
 * and written back through `walkthrough-core`.
 *
 * @returns Whether the walkthrough should show, and the four ways to move on:
 *   `finish`, `skip`, `postpone` and `reopen`
 *
 * @remarks
 * `storage` is read on mount and again whenever `id` or `version` changes: a
 * record for `version` keeps the walkthrough closed, and anything else
 * (nothing stored, another version, a record that does not decode) opens it.
 * `finish` and `skip` close the walkthrough, then stamp their outcome with
 * `version` and the current time and write the record; a storage error throws
 * from them, leaving the walkthrough closed with nothing kept, so it opens
 * again on the next mount.
 */
const useWalkthrough = ({ storage, id, version }: UseWalkthroughOptions): WalkthroughPrompt => {
  const isUnseen = (): boolean => readSeenWalkthrough(storage, id, version) === undefined
  const [openState, setOpenState] = useState<OpenState>(() => ({ id, version, open: isUnseen() }))
  let current = openState
  if (openState.id !== id || openState.version !== version) {
    current = { id, version, open: isUnseen() }
    setOpenState(current)
  }

  const setOpen = useCallback(
    (open: boolean): void => {
      setOpenState({ id, version, open })
    },
    [id, version]
  )

  const recordOutcome = useCallback(
    (outcome: WalkthroughOutcome): void => {
      setOpen(false)
      writeSeenWalkthrough(storage, id, {
        version,
        outcome,
        decidedAt: new Date().toISOString(),
      })
    },
    [setOpen, storage, id, version]
  )

  const finish = useCallback((): void => {
    recordOutcome('Finished')
  }, [recordOutcome])

  const skip = useCallback((): void => {
    recordOutcome('Skipped')
  }, [recordOutcome])

  const postpone = useCallback((): void => {
    setOpen(false)
  }, [setOpen])

  const reopen = useCallback((): void => {
    setOpen(true)
  }, [setOpen])

  return { open: current.open, finish, skip, postpone, reopen }
}

export { useWalkthrough }
export type { UseWalkthroughOptions, WalkthroughPrompt }
