import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { ErrorBanner, TextField } from '@wildflowerhealthio/react-tundraish'
import { type ComponentProps, type JSX, useState } from 'react'

import styles from './key-setup.module.css'

/** Props for {@link KeySetup}: its own two, and any other `<form>` prop. */
interface KeySetupProps extends Omit<ComponentProps<'form'>, 'children' | 'onSubmit'> {
  /** The API did not accept the key last tried. */
  readonly keyWasRejected: boolean
  /** The browser refused to read a kept key, which is why one is asked for. */
  readonly keyUnreadable: boolean
  /** Called with what was typed when the person saves it. */
  readonly onSaveKey: (typedKey: string) => void
}

/**
 * Asking for the person's Claude API key: a password field saying where the
 * key goes, that a saved key couldn't be read when the browser refused,
 * "This key wasn't accepted" when the last one was not, then
 * "Save key".
 */
const KeySetup = ({
  keyWasRejected,
  keyUnreadable,
  onSaveKey,
  className,
  ...rootProps
}: KeySetupProps): JSX.Element => {
  const [typedKey, setTypedKey] = useState('')
  return (
    <form
      {...rootProps}
      className={cn(styles['key-setup'], className)}
      onSubmit={(event) => {
        event.preventDefault()
        onSaveKey(typedKey)
      }}
    >
      <TextField
        label="Claude API key"
        type="password"
        value={typedKey}
        onChange={setTypedKey}
        description="Your key stays in this browser and is only sent to Anthropic."
      />
      {keyUnreadable ? (
        <p role="status" className="text-body-3">
          This browser wouldn&apos;t read a saved key, so you&apos;ll enter it each time.
        </p>
      ) : null}
      {keyWasRejected ? <ErrorBanner error="This key wasn't accepted." /> : null}
      <button type="submit" className="button-2 filled" disabled={typedKey.trim() === ''}>
        Save key
      </button>
    </form>
  )
}

export { KeySetup }
export type { KeySetupProps }
