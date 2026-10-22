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
  /** No record for this version yet, or reopened. */
  readonly open: boolean
  /** Record that the visitor went through every step, and close the walkthrough. */
  readonly finish: () => void
  /** Record that the visitor left before the last step, and close the walkthrough. */
  readonly skip: () => void
  /** Show the walkthrough again over a record already kept ("Show walkthrough again"). */
  readonly reopen: () => void
}

/**
 * Whether the visitor has been through walkthrough `id`, read from `storage`
 * and written back through `walkthrough-core`.
 *
 * @returns Whether the walkthrough should show, and the three ways to move on:
 *   `finish`, `skip` and `reopen`
 *
 * @remarks
 * `storage` is read once, on mount: a record for `version` keeps the
 * walkthrough closed, and anything else (nothing stored, another version, a
 * record that does not decode) opens it. `finish` and `skip` stamp their
 * outcome with `version` and the current time, write the record, and close the
 * walkthrough; a storage error throws from them rather than closing a
 * walkthrough whose outcome was never kept.
 */
const useWalkthrough = ({ storage, id, version }: UseWalkthroughOptions): WalkthroughPrompt => {
  const [open, setOpen] = useState(() => readSeenWalkthrough(storage, id, version) === undefined)

  const recordOutcome = useCallback(
    (outcome: WalkthroughOutcome): void => {
      writeSeenWalkthrough(storage, id, {
        version,
        outcome,
        decidedAt: new Date().toISOString(),
      })
      setOpen(false)
    },
    [storage, id, version]
  )

  const finish = useCallback((): void => {
    recordOutcome('Finished')
  }, [recordOutcome])

  const skip = useCallback((): void => {
    recordOutcome('Skipped')
  }, [recordOutcome])

  const reopen = useCallback((): void => {
    setOpen(true)
  }, [])

  return { open, finish, skip, reopen }
}

export { useWalkthrough }
export type { UseWalkthroughOptions, WalkthroughPrompt }
