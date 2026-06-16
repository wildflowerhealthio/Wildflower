import { createFileRoute } from '@tanstack/react-router'
import { useId, useState, type ChangeEvent, type JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, Field, FieldDescription, pageLayoutStyles } from 'react-tundraish'

import { TunnelToggle } from '../../../components/TunnelToggle.tsx'
import {
  tunnelStateQueryOptions,
  useTunnelReplaceMutation,
  useTunnelStateQuery,
  type RelayInput,
  type TunnelState,
} from '../../../queries.ts'
import styles from './index.module.css'

interface TunnelScreenBodyProps {
  readonly state: TunnelState
}

// The relay block is collected straight into the wire `RelayInput` (all four
// fields are strings the user types). Reusing the type means a field add/rename
// on `RelayInputSchema` is a compile error here, not silent drift.
const EMPTY_RELAY: RelayInput = { remoteAddr: '', token: '', publicKey: '', serviceName: '' }

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
  { key: 'token', label: 'Token', type: 'password' },
  { key: 'publicKey', label: 'Public key', type: 'text', placeholder: 'base64 noise public key' },
  { key: 'serviceName', label: 'Service name', type: 'text', placeholder: 'wildflower' },
]

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
  const hostId = useId()
  const relayIdBase = useId()
  const [publicHostInput, setPublicHostInput] = useState(state.publicHost ?? '')
  const [syncedRevision, setSyncedRevision] = useState(state.revision)
  const [relay, setRelay] = useState<RelayInput>(EMPTY_RELAY)
  // Unresolved-conflict signal. Tracked explicitly (not derived from
  // `mutation.data`) so it survives an unrelated toggle and only clears
  // when the user acts on the host. Set by any 409, cleared by a host
  // re-save (Applied) or a fresh host edit.
  const [conflict, setConflict] = useState(false)

  // Re-seed the editable host whenever the server snapshot advances — an
  // Applied save *or* an adopted 409 snapshot. Without this the input keeps
  // a stale edit after a conflict, the "current values are shown below"
  // banner lies, and a re-Save (now carrying the fresh revision) silently
  // clobbers the concurrent writer. React's documented "adjust state on
  // prop change during render" pattern.
  if (syncedRevision !== state.revision) {
    setSyncedRevision(state.revision)
    setPublicHostInput(state.publicHost ?? '')
  }

  // Locks inputs even though the optimistic state has already advanced.
  const pending = replaceMutation.isPending
  const transportError = replaceMutation.error
  const errorMessage = transportError === null ? null : formatError(transportError)

  const nextPublicHost = normalizeOptionalString(publicHostInput)
  const hostDirty = nextPublicHost !== state.publicHost

  // Relay is all-or-nothing: send all four or none. A partial draft is a
  // client-side error, never a partial PUT (which would corrupt the
  // stored relay).
  const relayTrimmed: RelayInput = {
    remoteAddr: relay.remoteAddr.trim(),
    token: relay.token.trim(),
    publicKey: relay.publicKey.trim(),
    serviceName: relay.serviceName.trim(),
  }
  const relayFilledCount = Object.values(relayTrimmed).filter((value) => value !== '').length
  const relayComplete = relayFilledCount === 4
  const relayPartial = relayFilledCount > 0 && relayFilledCount < 4

  const updateRelay =
    (key: keyof RelayInput) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const { value } = event.target
      setRelay((draft) => ({ ...draft, [key]: value }))
    }

  const canSave = !pending && !relayPartial && (hostDirty || relayComplete)

  const onToggle = (requestedRunning: boolean): void => {
    // Toggle never touches the host or relay — the mutation fills those
    // from the freshest cached snapshot. A toggle that itself 409s raises
    // the banner, but an Applied toggle never *clears* it (a toggle doesn't
    // resolve a pending host conflict).
    replaceMutation.mutate(
      { requestedRunning },
      {
        onSuccess: (result) => {
          if (result._tag === 'Conflict') setConflict(true)
        },
      }
    )
  }

  const onSave = (): void => {
    replaceMutation.mutate(
      {
        publicHost: nextPublicHost,
        ...(relayComplete ? { relay: relayTrimmed } : {}),
      },
      {
        onSuccess: (result) => {
          if (result._tag === 'Conflict') {
            setConflict(true)
            return
          }
          // Applied: the host write landed — resolve the conflict and clear
          // the (write-only) relay draft now that it's actually stored.
          setConflict(false)
          if (relayComplete) setRelay(EMPTY_RELAY)
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

      {conflict ? (
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
        <Field label="Public host" htmlFor={hostId}>
          <input
            id={hostId}
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
              // Editing the host acknowledges the refreshed values and is a
              // fresh, non-stale decision — so dismiss the conflict banner.
              if (conflict) setConflict(false)
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
          {RELAY_FIELDS.map((field) => {
            const fieldId = `${relayIdBase}-${field.key}`
            return (
              <Field key={field.key} label={field.label} htmlFor={fieldId}>
                <input
                  id={fieldId}
                  type={field.type}
                  inputMode={field.inputMode}
                  autoComplete="off"
                  autoCapitalize="none"
                  className={styles['input']}
                  value={relay[field.key]}
                  placeholder={field.placeholder}
                  disabled={pending}
                  onChange={updateRelay(field.key)}
                />
              </Field>
            )
          })}
        </div>
      </details>

      {relayPartial ? (
        // Outside the collapsible block so a disabled Save is always
        // explained even when the relay section is collapsed.
        <p className={cn(styles['relay__error'], 'text-body-3')} role="alert">
          Fill all four relay fields, or clear them all to keep the stored connection.
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
