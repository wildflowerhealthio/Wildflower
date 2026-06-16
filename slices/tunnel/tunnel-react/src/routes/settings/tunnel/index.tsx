import { createFileRoute } from '@tanstack/react-router'
import { useState, type ChangeEvent, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, Field, FieldDescription, pageLayoutStyles } from 'react-tundraish'

import { TunnelToggle } from '../../../components/TunnelToggle.tsx'
import {
  tunnelStateQueryOptions,
  useTunnelReplaceMutation,
  useTunnelStateQuery,
  type TunnelState,
} from '../../../queries.ts'
import styles from './index.module.css'

interface TunnelScreenBodyProps {
  readonly state: TunnelState
}

/** The four write-only relay fields, as free text the user is editing. */
interface RelayDraft {
  readonly remoteAddr: string
  readonly token: string
  readonly publicKey: string
  readonly serviceName: string
}

const EMPTY_RELAY: RelayDraft = { remoteAddr: '', token: '', publicKey: '', serviceName: '' }

/**
 * Empty input maps to `null` so clearing `publicHost` becomes an explicit
 * `null` write (the wire schema is present-but-nullable: `null` clears the
 * host, a string sets it).
 */
const normalizeOptionalString = (raw: string): string | null => {
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const TunnelScreenBody = ({ state }: TunnelScreenBodyProps): JSX.Element => {
  const replaceMutation = useTunnelReplaceMutation()
  const [publicHostInput, setPublicHostInput] = useState(state.publicHost ?? '')
  const [relay, setRelay] = useState<RelayDraft>(EMPTY_RELAY)

  // Locks inputs even though the optimistic state has already advanced.
  const pending = replaceMutation.isPending
  const transportError = replaceMutation.error
  const errorMessage = transportError === null ? null : formatError(transportError)
  // A 409 resolves successfully into a `Conflict` result; surface it so
  // the user re-checks the now-refreshed values before retrying.
  const conflicted = replaceMutation.data?._tag === 'Conflict'

  const nextPublicHost = normalizeOptionalString(publicHostInput)
  const hostDirty = nextPublicHost !== state.publicHost

  // Relay is all-or-nothing: send all four or none. A partial draft is a
  // client-side error, never a partial PUT (which would corrupt the
  // stored relay).
  const relayTrimmed: RelayDraft = {
    remoteAddr: relay.remoteAddr.trim(),
    token: relay.token.trim(),
    publicKey: relay.publicKey.trim(),
    serviceName: relay.serviceName.trim(),
  }
  const relayFilledCount = Object.values(relayTrimmed).filter((value) => value !== '').length
  const relayComplete = relayFilledCount === 4
  const relayPartial = relayFilledCount > 0 && relayFilledCount < 4

  const updateRelay =
    (key: keyof RelayDraft) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const { value } = event.target
      setRelay((draft) => ({ ...draft, [key]: value }))
    }

  const canSave = !pending && !relayPartial && (hostDirty || relayComplete)

  const onToggle = (requestedRunning: boolean): void => {
    // Toggle never touches the host or relay — the mutation fills those
    // from the freshest cached snapshot.
    replaceMutation.mutate({ requestedRunning })
  }

  const onSave = (): void => {
    if (relayPartial) return
    replaceMutation.mutate(
      {
        publicHost: nextPublicHost,
        ...(relayComplete ? { relay: relayTrimmed } : {}),
      },
      {
        // Clear the (write-only) relay draft once it's actually stored —
        // not on a 409, where no write happened and the user must retry.
        onSuccess: (result) => {
          if (result._tag === 'Applied' && relayComplete) setRelay(EMPTY_RELAY)
        },
      }
    )
  }

  return (
    <>
      <h1 className="text-heading-6">Tunnel</h1>
      <FieldDescription>
        Expose this device to the public Internet so apps installed on phones can reach it.
      </FieldDescription>

      {errorMessage !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          {errorMessage}
        </p>
      ) : null}

      {conflicted ? (
        <p className={cn(styles['conflict'], 'text-body-3')} role="status">
          These settings changed elsewhere. The current values are shown below — review them and
          save again to apply your change.
        </p>
      ) : null}

      <TunnelToggle
        requestedRunning={state.requestedRunning}
        running={state.running}
        error={state.error}
        disabled={pending}
        onToggle={onToggle}
      />

      <div className={styles['fields']}>
        <Field label="Public host">
          <input
            type="text"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            className={styles['input']}
            value={publicHostInput}
            placeholder="my-clinic.example.com"
            disabled={pending}
            onChange={(e) => {
              setPublicHostInput(e.target.value)
            }}
          />
          <FieldDescription>The public domain the relay routes to this device.</FieldDescription>
        </Field>
      </div>

      <details className={styles['relay']}>
        <summary className={styles['relay__summary']}>Relay connection</summary>
        <FieldDescription>
          Connection details for the self-hosted rathole relay. Stored securely and not shown after
          saving — re-enter all four fields to change them.
        </FieldDescription>

        <div className={styles['fields']}>
          <Field label="Relay address">
            <input
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              className={styles['input']}
              value={relay.remoteAddr}
              placeholder="relay.example.com:2333"
              disabled={pending}
              onChange={updateRelay('remoteAddr')}
            />
          </Field>

          <Field label="Token">
            <input
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              className={styles['input']}
              value={relay.token}
              disabled={pending}
              onChange={updateRelay('token')}
            />
          </Field>

          <Field label="Public key">
            <input
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              className={styles['input']}
              value={relay.publicKey}
              placeholder="base64 noise public key"
              disabled={pending}
              onChange={updateRelay('publicKey')}
            />
          </Field>

          <Field label="Service name">
            <input
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              className={styles['input']}
              value={relay.serviceName}
              placeholder="wildflower"
              disabled={pending}
              onChange={updateRelay('serviceName')}
            />
          </Field>
        </div>

        {relayPartial ? (
          <p className={cn(styles['relay__error'], 'text-body-3')} role="alert">
            Fill all four relay fields, or clear them all to keep the stored connection.
          </p>
        ) : null}
      </details>

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
        <button type="button" className="button-2 filled" disabled={!canSave} onClick={onSave}>
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
