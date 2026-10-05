import { useState, type SubmitEvent, type JSX } from 'react'
import { ErrorBanner, TextField } from 'react-tundraish'

import { useSignInMutation } from './queries/index.ts'
import { useRelayAdmin } from './relay-admin-context.ts'
import styles from './admin-key-form.module.css'

/** Shown when the relay answered `401` to the stored key. */
const KEY_REFUSED_MESSAGE =
  'The relay refused the admin key. Either it is not WILDFLOWER_RELAY_ADMIN_KEY, or this device’s clock is more than a minute off the relay’s. Paste the key again.'

/**
 * Sign-in: the operator pastes `WILDFLOWER_RELAY_ADMIN_KEY` once. The browser
 * keeps a non-extractable signing key made from it, never the text.
 */
const AdminKeyForm = (): JSX.Element => {
  const [pasted, setPasted] = useState('')
  const signIn = useSignInMutation()
  const { keyRefused } = useRelayAdmin()
  const onSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    signIn.mutate(pasted, {
      onSuccess: () => {
        setPasted('')
      },
    })
  }
  return (
    <form className={styles['admin-key-form']} onSubmit={onSubmit}>
      <h2 className="text-heading-4">Sign in</h2>
      <p className="text-body-2">
        Paste the relay’s <code>WILDFLOWER_RELAY_ADMIN_KEY</code>. This browser keeps a key that can
        sign requests to the relay, not the text you paste, until you sign out.
      </p>
      {keyRefused ? (
        <p className={styles['admin-key-form__refused']} role="alert">
          {KEY_REFUSED_MESSAGE}
        </p>
      ) : null}
      <TextField label="Admin key" type="password" value={pasted} onChange={setPasted} />
      <ErrorBanner error={signIn.error} />
      <div className={styles['admin-key-form__actions']}>
        <button
          type="submit"
          className="button-2 filled"
          disabled={signIn.isPending || pasted.trim() === ''}
        >
          Sign in
        </button>
      </div>
    </form>
  )
}

export { AdminKeyForm, KEY_REFUSED_MESSAGE }
