import { createFileRoute } from '@tanstack/react-router'
import { useState, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, Chip, PageHeader, TextField, pageLayoutStyles } from 'react-tundraish'

import {
  tunnelStateQueryOptions,
  useTunnelStateQuery,
  type RelayInput,
  type TunnelState,
} from '../../../queries.ts'
import { useTunnelSettingsForm } from '../../../use-tunnel-settings-form.ts'
import styles from './relay.module.css'

interface RelaySettingsScreenBodyProps {
  readonly state: TunnelState
}

interface RelayFieldDescriptor {
  readonly key: keyof RelayInput
  readonly label: string
  readonly type: 'text' | 'password'
  readonly placeholder?: string
  readonly inputMode?: 'url'
  readonly description?: string
  readonly callout?: boolean
}

/*
 * Two groups separated by a hairline. The top group carries the
 * device-facing fields (Service name + the actively-changed Token); the
 * bottom group carries the rarely-touched relay endpoint coordinates
 * (Relay address + Public key). The split is purely visual — at save
 * time the four relay fields are still all-or-nothing (a dirty change
 * still requires a fresh token), so the existing validation copy still
 * reads "fill all four fields including a new token".
 */
const TOP_RELAY_FIELDS: ReadonlyArray<RelayFieldDescriptor> = [
  {
    key: 'serviceName',
    label: 'Service name',
    type: 'text',
    placeholder: 'wildflower-device-1',
  },
  {
    key: 'token',
    label: 'Token',
    type: 'password',
    placeholder: 'Enter to change connection',
    description: 'Never shown — enter a new token to change the connection.',
    callout: true,
  },
]

const BOTTOM_RELAY_FIELDS: ReadonlyArray<RelayFieldDescriptor> = [
  {
    key: 'remoteAddr',
    label: 'Relay address',
    type: 'text',
    placeholder: 'relay.example.com:2333',
    inputMode: 'url',
  },
  {
    key: 'publicKey',
    label: 'Public key',
    type: 'text',
    placeholder: 'base64 noise public key',
  },
]

/** Visual states the Test connection button cycles through. The actual
 * dial-test integration is a future slice; the click handler below is a
 * stub that sequences the states so the design can be reviewed. */
type TestStatus = 'idle' | 'loading' | 'success' | 'error'

const RelaySettingsScreenBody = ({ state }: RelaySettingsScreenBodyProps): JSX.Element => {
  const form = useTunnelSettingsForm(state)
  const [testStatus, setTestStatus] = useState<TestStatus>('idle')

  /*
   * Stub the Test connection action: a future slice will wire it to a
   * real dial probe (the daemon's relay-side handshake). For now we
   * sequence through the visual states so the design intent is
   * exercised — `loading` flips to `success` after a beat, and an
   * `error` state is reachable by re-clicking after a success.
   */
  const handleTest = (): void => {
    setTestStatus('loading')
    setTimeout(() => {
      setTestStatus((prev) => (prev === 'loading' ? 'success' : prev))
    }, 1500)
  }

  const testLabel: Record<TestStatus, string> = {
    idle: 'Test connection',
    loading: 'Testing…',
    success: 'Connection OK',
    error: 'Test failed',
  }

  const renderRelayField = (field: RelayFieldDescriptor): JSX.Element => (
    <TextField
      key={field.key}
      label={field.label}
      type={field.type}
      inputMode={field.inputMode}
      placeholder={field.placeholder}
      value={form.relay[field.key]}
      description={field.description}
      callout={field.callout}
      disabled={form.pending}
      onChange={(next) => {
        form.setRelayField(field.key, next)
      }}
    />
  )

  return (
    <>
      <PageHeader
        title={<>Relay settings</>}
        actions={<Chip className={styles['title-chip']}>Advanced</Chip>}
        backHref="/settings/tunnel"
        backLabel="Tunnel"
      />

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

      <div className={styles['fields']}>
        <h2 className={styles['zone-label']}>Your Settings</h2>
        <TextField
          label="Public host"
          type="text"
          inputMode="url"
          placeholder="my-clinic.example.com"
          value={form.hostInput}
          description="The public domain the relay routes to this device."
          disabled={form.pending}
          onChange={form.setHostInput}
        />

        {TOP_RELAY_FIELDS.map(renderRelayField)}

        <h2 className={styles['zone-label']}>Relay Server</h2>
        {BOTTOM_RELAY_FIELDS.map(renderRelayField)}
      </div>

      {form.relayInvalid ? (
        <p className={cn(styles['relay-error'], 'text-body-3')} role="alert">
          To change the relay, fill all four fields including a new token.
        </p>
      ) : null}

      <p className={styles['current']}>
        Bound to local server at: {state.servedOrigin}
        {state.dialAttempts > 0 ? (
          <>
            <br />
            Dial attempts this revision: {state.dialAttempts}
          </>
        ) : null}
      </p>

      <div className={styles['actions']}>
        {testStatus !== 'idle' && testStatus !== 'loading' ? (
          <span
            className={cn(
              styles['test-status'],
              testStatus === 'success' ? styles['test-status--success'] : null,
              testStatus === 'error' ? styles['test-status--error'] : null
            )}
            role="status"
          >
            {testStatus === 'success' ? 'Relay reachable.' : 'Could not reach the relay.'}
          </span>
        ) : null}
        <button
          type="button"
          className={cn('button-2 outline', styles['test-button'])}
          disabled={form.pending || testStatus === 'loading'}
          onClick={handleTest}
        >
          {testLabel[testStatus]}
        </button>
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

const RelaySettingsScreenContent = (): JSX.Element => {
  const { data: state } = useTunnelStateQuery()
  return <RelaySettingsScreenBody state={state} />
}

/**
 * Loader warms the `TunnelState` cache for first paint, mirroring the
 * Tunnel overview's loader. The `/settings` layout gates on a
 * `beforeLoad` that `await`s the bearer token, so by the time this
 * loader runs the token is guaranteed present. Failures propagate so
 * the route's `errorComponent` renders rather than vanishing silently.
 */
export const Route = createFileRoute('/settings/tunnel/relay')({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(tunnelStateQueryOptions(context.runAuthed))
  },
  component: RelaySettingsScreenContent,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Relay settings" />,
})
