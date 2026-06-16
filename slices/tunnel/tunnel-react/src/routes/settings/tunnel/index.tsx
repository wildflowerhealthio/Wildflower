import { createFileRoute } from '@tanstack/react-router'
import { unknownErrorToString } from 'kitchen-sink'
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
//
// Build the editable draft from the returned state: the three non-secret fields
// prefill, but the write-only `token` always starts blank — the server never
// returns it, so changing the relay requires re-entering it.
const relayDraftFromState = (state: TunnelState): RelayInput => ({
  remoteAddr: state.relay?.remoteAddr ?? '',
  publicKey: state.relay?.publicKey ?? '',
  serviceName: state.relay?.serviceName ?? '',
  token: '',
})

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

/**
 * Empty input maps to `null` so clearing `publicHost` becomes an explicit
 * `null` write (the wire schema is present-but-nullable: `null` clears the
 * host, a string sets it).
 */
const normalizeOptionalString = (raw: string): string | null => {
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

const TunnelScreenBody = ({ state }: TunnelScreenBodyProps): JSX.Element => {
  const replaceMutation = useTunnelReplaceMutation()
  const hostInputDomId = useId()
  const relayInputDomIdBase = useId()
  const [publicHostInput, setPublicHostInput] = useState(state.publicHost ?? '')
  const [relay, setRelay] = useState<RelayInput>(() => relayDraftFromState(state))
  // The server values the inputs were last synced to, tracked per field so a
  // genuine change to *this* field is distinguishable from an unrelated
  // revision bump.
  const [syncedServerHost, setSyncedServerHost] = useState(state.publicHost)
  const [syncedServerRelay, setSyncedServerRelay] = useState(state.relay)
  // Unresolved-conflict signal. Tracked explicitly (not derived from
  // `mutation.data`) so it survives an unrelated toggle and only clears
  // when the user re-saves (Applied) or makes a fresh host edit.
  const [updateDidConflict, setUpdateDidConflict] = useState(false)

  // Re-seed an editable field from the server snapshot only when *that field's*
  // server value changed since we last synced — the rebase a 409 conflict
  // demands. A field the server didn't touch keeps the user's text, so an
  // unsaved edit survives an unrelated revision bump (e.g. an Applied toggle).
  // React's documented "adjust state on prop change during render" pattern.
  if (syncedServerHost !== state.publicHost) {
    setSyncedServerHost(state.publicHost)
    setPublicHostInput(state.publicHost ?? '')
  }
  const relayServerChanged = RELAY_FIELDS.some(
    ({ key }) => key !== 'token' && (syncedServerRelay?.[key] ?? '') !== (state.relay?.[key] ?? '')
  )
  if (relayServerChanged) {
    setSyncedServerRelay(state.relay)
    // Adopt only the changed non-secret relay fields, and keep the user's typed
    // token: it's write-only and never echoed, so a conflict elsewhere must not
    // discard an in-progress relay change.
    setRelay((draft) =>
      RELAY_FIELDS.reduce<RelayInput>((next, { key }) => {
        if (key === 'token' || (syncedServerRelay?.[key] ?? '') === (state.relay?.[key] ?? '')) {
          return next
        }
        return { ...next, [key]: state.relay?.[key] ?? '' }
      }, draft)
    )
  }

  // Locks inputs even though the optimistic state has already advanced.
  const pending = replaceMutation.isPending
  const transportError = replaceMutation.error
  const errorMessage = transportError === null ? null : unknownErrorToString(transportError)

  const nextPublicHost = normalizeOptionalString(publicHostInput)
  const hostDirty = nextPublicHost !== state.publicHost

  // The server-stored value to compare an edited relay field against. The
  // token is write-only — never echoed back — so its baseline is always empty
  // and any entered token reads as a change.
  const storedRelayValue = (key: keyof RelayInput): string =>
    key === 'token' ? '' : (state.relay?.[key] ?? '')

  // RELAY_FIELDS is the single source for the relay field set: a field added
  // there flows into the trim, the dirty check, and the completeness check
  // automatically — no hand-listed key can silently fall out of sync.
  const relayTrimmed = RELAY_FIELDS.reduce<RelayInput>(
    (trimmed, { key }) => ({ ...trimmed, [key]: trimmed[key].trim() }),
    relay
  )
  // Only a *dirtied* relay is validated and sent. Dirty = any field differs
  // from its stored baseline (so any entered token counts). An untouched
  // relay is omitted from the PUT — the server keeps the stored connection.
  const relayDirty = RELAY_FIELDS.some(({ key }) => relayTrimmed[key] !== storedRelayValue(key))
  // A relay change is all-or-nothing and must carry a fresh token (the stored
  // one can't be reused — it's never echoed back).
  const relayComplete = RELAY_FIELDS.every(({ key }) => relayTrimmed[key] !== '')
  const relayInvalid = relayDirty && !relayComplete

  const updateRelay =
    (key: keyof RelayInput) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      const { value } = event.target
      setRelay((draft) => ({ ...draft, [key]: value }))
    }

  const canSave = !pending && !relayInvalid && (hostDirty || relayDirty)

  const onToggle = (requestedRunning: boolean): void => {
    // Toggle never touches the host or relay — the mutation fills those
    // from the freshest cached snapshot. A toggle that itself 409s raises
    // the banner, but an Applied toggle never *clears* it (a toggle doesn't
    // resolve a pending host conflict).
    replaceMutation.mutate(
      { requestedRunning },
      {
        onSuccess: (result) => {
          if (result._tag === 'Conflict') setUpdateDidConflict(true)
        },
      }
    )
  }

  const onSave = (): void => {
    replaceMutation.mutate(
      {
        publicHost: nextPublicHost,
        ...(relayDirty ? { relay: relayTrimmed } : {}),
      },
      {
        onSuccess: (result) => {
          setUpdateDidConflict(result._tag === 'Conflict')
          // Applied: the relay write landed and its token is now stored, so
          // blank the write-only token input. On a Conflict no write happened —
          // keep the user's typed relay (incl. token) so a re-Save still carries
          // it; any changed-elsewhere fields are rebased by the re-seed above.
          if (result._tag === 'Applied' && relayDirty) {
            setRelay((draft) => ({ ...draft, token: '' }))
          }
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

      {updateDidConflict ? (
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
        <Field label="Public host" htmlFor={hostInputDomId}>
          <input
            id={hostInputDomId}
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
              if (updateDidConflict) setUpdateDidConflict(false)
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

      {relayInvalid ? (
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
