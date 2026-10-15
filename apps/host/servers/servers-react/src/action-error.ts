import { useCallback, useState } from 'react'

/**
 * The latest failure of a row of action buttons, for one full-width banner
 * above the row, with the callbacks each button reports through: a button
 * calls `onActionStart` as it starts an action, which clears the failure,
 * and `onError` with the failure's text when the action fails.
 */
interface ActionError {
  /** The text of the latest failure, or `null` since the last action started. */
  readonly error: string | null
  readonly onActionStart: () => void
  readonly onError: (failure: string) => void
}

/** An {@link ActionError} held in the calling component's state. */
const useActionError = (): ActionError => {
  const [error, setError] = useState<string | null>(null)
  const onActionStart = useCallback(() => {
    setError(null)
  }, [])
  return { error, onActionStart, onError: setError }
}

export { useActionError, type ActionError }
