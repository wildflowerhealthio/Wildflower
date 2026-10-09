import { useNavigate, useRouteContext } from '@tanstack/react-router'
import { Match, Option } from 'effect'
import { type JSX, type ReactNode, useId, useState } from 'react'
import {
  ErrorBanner,
  GateCard,
  PageHeader,
  RadioGroup,
  TextField,
  ToggleSwitch,
} from 'react-tundraish'
import type { EnteredRelay, RunPolicyChoice } from 'servers-core'

import { failureText } from './failure-text.ts'
import { useAddServer, useSetServerRunPolicy } from './queries.ts'
import type { RouterContext, RunHostCommand } from './router-context.ts'
import styles from './add-server-page.module.css'

/** Whether the relay is the Wildflower relay or one the user names. */
type RelayChoice = 'wildflowerOfficial' | 'custom'

/** The relay step's fields, as typed. */
interface RelayEntries {
  readonly choice: RelayChoice
  /** A custom relay's Wildflower relay site, unless it is a rathole relay. */
  readonly baseUrl: string
  /** Whether a custom relay is a rathole relay, with no relay site. */
  readonly isRatholeRelay: boolean
  /** A pin's or a rathole relay's `host:port`. */
  readonly remoteAddr: string
  /** A pin's or a rathole relay's noise public key. */
  readonly publicKey: string
  /** A rathole relay's relay domain. */
  readonly ratholeDomain: string
}

/** The credentials step's fields, as typed. */
interface CredentialsEntries {
  readonly tunnelName: string
  readonly token: string
}

/**
 * The step showing: past the relay step, with the relay entered; once the
 * server is added, with its domain.
 */
type Step =
  | { readonly kind: 'relay' }
  | { readonly kind: 'credentials'; readonly relay: EnteredRelay.Type }
  | { readonly kind: 'checking'; readonly relay: EnteredRelay.Type }
  | { readonly kind: 'done'; readonly domain: string }

const NO_RELAY_ENTRIES: RelayEntries = {
  choice: 'wildflowerOfficial',
  baseUrl: '',
  isRatholeRelay: false,
  remoteAddr: '',
  publicKey: '',
  ratholeDomain: '',
}

const NO_CREDENTIALS_ENTRIES: CredentialsEntries = { tunnelName: '', token: '' }

/** The relay step's two choices, by their {@link RelayChoice}. */
const RELAY_CHOICES = [
  { value: 'wildflowerOfficial', label: 'Wildflower relay' },
  { value: 'custom', label: 'Custom relay' },
] as const

/**
 * The relay `entries` describe, each setting trimmed, or nothing while one
 * it needs is empty: a pin needs both its settings or neither, and a rathole
 * relay all three. The host checks the settings themselves.
 */
const enteredRelayOf = (entries: RelayEntries): Option.Option<EnteredRelay.Type> => {
  if (entries.choice === 'wildflowerOfficial') return Option.some({ kind: 'wildflowerOfficial' })
  const remoteAddr = entries.remoteAddr.trim()
  const publicKey = entries.publicKey.trim()
  if (entries.isRatholeRelay) {
    const domain = entries.ratholeDomain.trim()
    return remoteAddr === '' || publicKey === '' || domain === ''
      ? Option.none()
      : Option.some({ kind: 'rathole', remoteAddr, publicKey, domain })
  }
  const baseUrl = entries.baseUrl.trim()
  if (baseUrl === '' || (remoteAddr === '') !== (publicKey === '')) return Option.none()
  return Option.some({
    kind: 'selfHostedWildflower',
    baseUrl,
    ...(remoteAddr === '' ? {} : { pin: { remoteAddr, publicKey } }),
  })
}

/** A step's heading, with what it is for under it. */
const StepHeading = ({
  headingId,
  title,
  children,
}: {
  readonly headingId: string
  readonly title: string
  readonly children: ReactNode
}): JSX.Element => (
  <>
    <h2 id={headingId} className={`text-heading-4 ${styles['add-server-page__title']}`}>
      {title}
    </h2>
    <p className={`text-body-2 ${styles['add-server-page__lead']}`}>{children}</p>
  </>
)

/**
 * The Advanced settings of a custom relay: its optional pin, or, switched to
 * a rathole relay, the rathole relay's identity and domain. Open while any
 * of them is entered.
 */
const AdvancedRelaySettings = ({
  entries,
  onChange,
}: {
  readonly entries: RelayEntries
  readonly onChange: (entries: RelayEntries) => void
}): JSX.Element => {
  const ratholeNoteId = useId()
  const [open, setOpen] = useState(
    () => entries.isRatholeRelay || entries.remoteAddr !== '' || entries.publicKey !== ''
  )
  return (
    <details
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open)
      }}
    >
      <summary className={`text-label-2 ${styles['add-server-page__advanced-summary']}`}>
        Advanced
      </summary>
      <div className={styles['add-server-page__fields']}>
        <ToggleSwitch
          label="A rathole relay, with no Wildflower relay site"
          checked={entries.isRatholeRelay}
          describedBy={ratholeNoteId}
          onChange={(isRatholeRelay) => {
            onChange({ ...entries, isRatholeRelay })
          }}
        />
        <p id={ratholeNoteId} className={`text-body-3 ${styles['add-server-page__note']}`}>
          {entries.isRatholeRelay
            ? "There's no relay site to ask, so nothing is checked until the tunnel comes up."
            : 'Optionally, pin the relay: it must present this address and key, which are checked and not stored.'}
        </p>
        <TextField
          label="Remote address"
          value={entries.remoteAddr}
          onChange={(remoteAddr) => {
            onChange({ ...entries, remoteAddr })
          }}
          placeholder="relay.example.com:2333"
          description="The host:port the tunnel dials."
        />
        <TextField
          label="Noise public key"
          value={entries.publicKey}
          onChange={(publicKey) => {
            onChange({ ...entries, publicKey })
          }}
          description="The relay's X25519 key, in base64."
        />
        {entries.isRatholeRelay ? (
          <TextField
            label="Relay domain"
            value={entries.ratholeDomain}
            onChange={(ratholeDomain) => {
              onChange({ ...entries, ratholeDomain })
            }}
            placeholder="relay.example.com"
            description="The domain this server's address ends in."
          />
        ) : null}
      </div>
    </details>
  )
}

/**
 * Step 1, the relay: the Wildflower relay, preselected, or a custom one by
 * its relay site's base URL, with its Advanced settings. Continue waits for
 * every setting the relay needs.
 */
const RelayStep = ({
  entries,
  onChange,
  onContinue,
}: {
  readonly entries: RelayEntries
  readonly onChange: (entries: RelayEntries) => void
  readonly onContinue: (relay: EnteredRelay.Type) => void
}): JSX.Element => {
  const headingId = useId()
  const relay = enteredRelayOf(entries)
  return (
    <form
      className={styles['add-server-page__step']}
      aria-labelledby={headingId}
      onSubmit={(event) => {
        event.preventDefault()
        if (Option.isSome(relay)) onContinue(relay.value)
      }}
    >
      <StepHeading headingId={headingId} title="Relay">
        Apps reach a server through a relay. Use Wildflower's, or one you run.
      </StepHeading>
      <RadioGroup
        name="relay"
        legend="Relay"
        value={entries.choice}
        options={RELAY_CHOICES}
        onChange={(choice) => {
          onChange({ ...entries, choice })
        }}
      />
      {entries.choice === 'custom' ? (
        <>
          {entries.isRatholeRelay ? null : (
            <TextField
              label="Relay base URL"
              type="url"
              inputMode="url"
              value={entries.baseUrl}
              onChange={(baseUrl) => {
                onChange({ ...entries, baseUrl })
              }}
              placeholder="https://relay.example.com"
              description="The address of the relay's Wildflower site."
            />
          )}
          <AdvancedRelaySettings entries={entries} onChange={onChange} />
        </>
      ) : null}
      <div className={styles['add-server-page__actions']}>
        <button type="submit" className="button-2 filled" disabled={Option.isNone(relay)}>
          Continue
        </button>
      </div>
    </form>
  )
}

/**
 * Step 2, the tunnel: its name and its token, masked. Add server waits for
 * both.
 */
const CredentialsStep = ({
  entries,
  onChange,
  onBack,
  onAdd,
}: {
  readonly entries: CredentialsEntries
  readonly onChange: (entries: CredentialsEntries) => void
  readonly onBack: () => void
  readonly onAdd: () => void
}): JSX.Element => {
  const headingId = useId()
  return (
    <form
      className={styles['add-server-page__step']}
      aria-labelledby={headingId}
      onSubmit={(event) => {
        event.preventDefault()
        onAdd()
      }}
    >
      <StepHeading headingId={headingId} title="Tunnel">
        The relay gives you a tunnel name and its token.
      </StepHeading>
      <TextField
        label="Tunnel name"
        value={entries.tunnelName}
        onChange={(tunnelName) => {
          onChange({ ...entries, tunnelName })
        }}
        description="It names this server's address."
      />
      <TextField
        label="Tunnel token"
        type="password"
        value={entries.token}
        onChange={(token) => {
          onChange({ ...entries, token })
        }}
        description="It's saved on this device and never shown again."
      />
      <div className={styles['add-server-page__actions']}>
        <button type="button" className="button-2 outline" onClick={onBack}>
          Back
        </button>
        <button
          type="submit"
          className="button-2 filled"
          disabled={entries.tunnelName.trim() === '' || entries.token.trim() === ''}
        >
          Add server
        </button>
      </div>
    </form>
  )
}

/**
 * Step 3, while the host checks what was entered and adds the server: with
 * a Wildflower relay, asking the relay; with a rathole relay, checking its
 * settings alone. When the host refuses, its message, with Back to the
 * tunnel step and Retry.
 */
const CheckingStep = ({
  relay,
  checking,
  failure,
  onBack,
  onRetry,
}: {
  readonly relay: EnteredRelay.Type
  /** Whether the host is still checking. */
  readonly checking: boolean
  /** The host's refusal, once it has refused. */
  readonly failure: Option.Option<string>
  readonly onBack: () => void
  readonly onRetry: () => void
}): JSX.Element => {
  const headingId = useId()
  return (
    <section className={styles['add-server-page__step']} aria-labelledby={headingId}>
      <StepHeading headingId={headingId} title="Checking">
        Nothing is saved until the check passes.
      </StepHeading>
      {checking ? (
        <GateCard
          title={
            relay.kind === 'rathole' ? 'Checking the relay settings…' : 'Checking with the relay…'
          }
        />
      ) : null}
      {failure.pipe(
        Option.map((message) => (
          <div key="failure" className={styles['add-server-page__step']}>
            <ErrorBanner error={message} />
            <div className={styles['add-server-page__actions']}>
              <button type="button" className="button-2 outline" onClick={onBack}>
                Back
              </button>
              <button type="button" className="button-2 filled" onClick={onRetry}>
                Retry
              </button>
            </div>
          </div>
        )),
        Option.getOrNull
      )}
    </section>
  )
}

/**
 * Step 4, the server added: its domain, what the relay sees, and Start now
 * or Start later, which set its run policy and open its page. The host's
 * refusal shows under them.
 */
const DoneStep = ({
  domain,
  runHostCommand,
}: {
  readonly domain: string
  readonly runHostCommand: RunHostCommand
}): JSX.Element => {
  const headingId = useId()
  const navigate = useNavigate()
  const setRunPolicy = useSetServerRunPolicy(runHostCommand)
  const start = (choice: RunPolicyChoice.Type): void => {
    setRunPolicy.mutate(
      { domain, choice },
      {
        onSuccess: () => {
          void navigate({ to: '/servers/$domain', params: { domain } })
        },
      }
    )
  }
  return (
    <section className={styles['add-server-page__step']} aria-labelledby={headingId}>
      <h2 id={headingId} className={`text-heading-4 ${styles['add-server-page__title']}`}>
        Server added
      </h2>
      <p className={styles['add-server-page__domain']}>{domain}</p>
      <p className={`text-body-2 ${styles['add-server-page__lead']}`}>
        Apps reach this server at this address through the relay. The relay passes traffic through
        and can't read your records.
      </p>
      <ErrorBanner error={setRunPolicy.error === null ? null : failureText(setRunPolicy.error)} />
      <div className={styles['add-server-page__actions']}>
        <button
          type="button"
          className="button-2 filled"
          disabled={setRunPolicy.isPending}
          onClick={() => {
            start({ kind: 'whileOpen' })
          }}
        >
          Start now
        </button>
        <button
          type="button"
          className="button-2 outline"
          disabled={setRunPolicy.isPending}
          onClick={() => {
            start({ kind: 'off' })
          }}
        >
          Start later
        </button>
      </div>
    </section>
  )
}

/**
 * Add server, `/servers/new`, a step at a time: the relay, the tunnel's
 * name and token, the host's check and enrolment, and the server added.
 *
 * @remarks
 * The steps and their entries live in this component's state, never the
 * URL, so the token doesn't reach it; and once the host has saved the
 * token, it is dropped from that state and from the mutation's (see
 * `useAddServer`). Back from a refusal keeps every entry.
 */
const AddServerPage = (): JSX.Element => {
  const runHostCommand = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runHostCommand,
  })
  const addServer = useAddServer(runHostCommand)
  const [step, setStep] = useState<Step>({ kind: 'relay' })
  const [relayEntries, setRelayEntries] = useState(NO_RELAY_ENTRIES)
  const [credentialsEntries, setCredentialsEntries] = useState(NO_CREDENTIALS_ENTRIES)
  const add = (relay: EnteredRelay.Type): void => {
    setStep({ kind: 'checking', relay })
    addServer.mutate(
      { relay, ...credentialsEntries },
      {
        onSuccess: (domain) => {
          addServer.reset()
          setCredentialsEntries((entries) => ({ ...entries, token: '' }))
          setStep({ kind: 'done', domain })
        },
      }
    )
  }
  const body = Match.value(step).pipe(
    Match.when({ kind: 'relay' }, () => (
      <RelayStep
        entries={relayEntries}
        onChange={setRelayEntries}
        onContinue={(relay) => {
          setStep({ kind: 'credentials', relay })
        }}
      />
    )),
    Match.when({ kind: 'credentials' }, ({ relay }) => (
      <CredentialsStep
        entries={credentialsEntries}
        onChange={setCredentialsEntries}
        onBack={() => {
          setStep({ kind: 'relay' })
        }}
        onAdd={() => {
          add(relay)
        }}
      />
    )),
    Match.when({ kind: 'checking' }, ({ relay }) => (
      <CheckingStep
        relay={relay}
        checking={addServer.isPending}
        failure={Option.fromNullable(addServer.error).pipe(Option.map(failureText))}
        onBack={() => {
          addServer.reset()
          setStep({ kind: 'credentials', relay })
        }}
        onRetry={() => {
          add(relay)
        }}
      />
    )),
    Match.when({ kind: 'done' }, ({ domain }) => (
      <DoneStep domain={domain} runHostCommand={runHostCommand} />
    )),
    Match.exhaustive
  )
  return (
    <>
      <PageHeader title="Add server" backHref="/" backLabel="Servers" />
      {body}
    </>
  )
}

export { AddServerPage }
