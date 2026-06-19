import { createFileRoute } from '@tanstack/react-router'
import { useId, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import {
  AsyncErrorView,
  Field,
  FieldDescription,
  PageHeader,
  pageLayoutStyles,
} from 'react-tundraish'

import { TunnelToggle } from '../../../components/TunnelToggle.tsx'
import {
  tunnelStateQueryOptions,
  useTunnelStateQuery,
  type RelayInput,
  type TunnelState,
} from '../../../queries.ts'
import { useTunnelSettingsForm } from '../../../use-tunnel-settings-form.ts'
import styles from './index.module.css'

interface TunnelScreenBodyProps {
  readonly state: TunnelState
}

/** Field descriptors for the relay block — single source for the repeated inputs. */
const RELAY_FIELDS: ReadonlyArray<{
  readonly key: keyof RelayInput
  readonly label: string
  readonly type: 'text' | 'password'
  readonly placeholder?: string
  readonly inputMode?: 'url'
}> = [
  {
    key: 'remoteAddr',
    label: 'Relay address',
    type: 'text',
    placeholder: 'relay.example.com:2333',
    inputMode: 'url',
  },
  { key: 'serviceName', label: 'Service name', type: 'text', placeholder: 'wildflower' },
  { key: 'publicKey', label: 'Public key', type: 'text', placeholder: 'base64 noise public key' },
  { key: 'token', label: 'Token', type: 'password' },
]

const TunnelScreenBody = ({ state }: TunnelScreenBodyProps): JSX.Element => {
  const form = useTunnelSettingsForm(state)
  const hostInputDomId = useId()
  const relayInputDomIdBase = useId()

  return (
    <>
      <PageHeader title="Tunnel" backHref="/settings" backLabel="Settings" />
      <FieldDescription>
        Expose this device to the public Internet so apps installed on phones can reach it.
      </FieldDescription>

      {form.errorMessage !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          {form.errorMessage}
        </p>
      ) : null}

      {form.conflicted ? (
        <p className={cn(styles['conflict'], 'text-body-3')} role="status">
          These settings changed elsewhere. The current values are shown below — review them and
          save again to apply your change.
        </p>
      ) : null}

      <TunnelToggle
        requestedRunning={state.requestedRunning}
        running={state.running}
        error={state.error}
        disabled={form.pending}
        onToggle={form.toggle}
      />

      <div className={styles['fields']}>
        <Field label="Public host" htmlFor={hostInputDomId}>
          <input
            id={hostInputDomId}
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            className={styles['input']}
            value={form.hostInput}
            placeholder="my-clinic.example.com"
            disabled={form.pending}
            onChange={(e) => {
              form.setHostInput(e.target.value)
            }}
          />
          <FieldDescription>The public domain the relay routes to this device.</FieldDescription>
        </Field>
      </div>

      <details className={styles['relay']}>
        <summary className={styles['relay__summary']}>Relay Server</summary>
        <FieldDescription>
          Connection details for the self-hosted rathole relay. The token is never shown — enter a
          new one to change the connection.
        </FieldDescription>

        <div className={styles['fields']}>
          {RELAY_FIELDS.map((field) => {
            const fieldId = `${relayInputDomIdBase}-${field.key}`
            return (
              <Field key={field.key} label={field.label} htmlFor={fieldId}>
                <input
                  id={fieldId}
                  type={field.type}
                  inputMode={field.inputMode}
                  autoComplete="off"
                  autoCapitalize="none"
                  className={styles['input']}
                  value={form.relay[field.key]}
                  placeholder={field.placeholder}
                  disabled={form.pending}
                  onChange={(e) => {
                    form.setRelayField(field.key, e.target.value)
                  }}
                />
              </Field>
            )
          })}
        </div>
      </details>

      {form.relayInvalid ? (
        // Outside the collapsible block so a disabled Save is always
        // explained even when the relay section is collapsed.
        <p className={cn(styles['relay__error'], 'text-body-3')} role="alert">
          To change the relay, fill all four fields including a new token.
        </p>
      ) : null}

      <FieldDescription>
        <span className={styles['current']}>Bound to local server at: {state.servedOrigin}</span>
        {state.attempt > 0 ? (
          <>
            <br />
            <span className={styles['current']}>Dial attempts this revision: {state.attempt}</span>
          </>
        ) : null}
      </FieldDescription>

      <div className={styles['actions']}>
        <button
          type="button"
          className="button-2 filled"
          disabled={!form.canSave}
          onClick={form.save}
        >
          Save
        </button>
      </div>
    </>
  )
}

const TunnelScreenContent = (): JSX.Element => {
  const { data: state } = useTunnelStateQuery()
  return <TunnelScreenBody state={state} />
}

/**
 * Loader warms the `TunnelState` cache for first paint. The `/settings`
 * layout gates on a `beforeLoad` that `await`s the bearer token, so by
 * the time this loader runs the token is guaranteed present — embedded
 * waited the bridge handshake, web had it synchronously. This is a plain
 * `ensureQueryData`.
 *
 * We deliberately do NOT swallow failures: a genuine error (no `/tunnel`
 * backend in web/node, 500, schema-invalid, network) propagates so the
 * route's `errorComponent` (`AsyncErrorView`) renders instead of
 * vanishing silently — important because `defaultPreload: 'intent'` fires
 * this loader on hover with no component mounted to surface the error.
 */
export const Route = createFileRoute('/settings/tunnel/')({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(tunnelStateQueryOptions(context.runAuthed))
  },
  component: TunnelScreenContent,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Tunnel" />,
})
