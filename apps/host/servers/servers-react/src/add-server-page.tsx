import { useNavigate } from '@tanstack/react-router'
import {
  ErrorBanner,
  GateCard,
  LinkButton,
  PageHeader,
  RadioGroup,
  TextField,
} from '@wildflowerhealthio/react-tundraish'
import {
  asksForAccessCodeDetails,
  EnteredCredentials,
  type EnteredRelay,
  type RunPolicyChoice,
} from '@wildflowerhealthio/servers-core-js'
import { Match, Option } from 'effect'
import { type JSX, type ReactNode, useId, useState } from 'react'

import { failureText } from './failure-text.ts'
import { useAddServer, useSetServerRunPolicy } from './queries.ts'
import { type RunHostCommand, useRunHostCommand } from './router-context.ts'
import styles from './add-server-page.module.css'

/** The relay step's fields, as typed. */
interface RelayEntries {
  readonly choice: EnteredRelay.Type['kind']
  /** A self-hosted Wildflower relay's base URL. */
  readonly baseUrl: string
  /** A pin's or a rathole relay's `host:port`. */
  readonly remoteAddr: string
  /** A pin's or a rathole relay's noise public key. */
  readonly publicKey: string
  /** A rathole relay's relay domain, lowercased as typed. */
  readonly ratholeDomain: string
}

/**
 * The credentials step's fields, as typed, the code uppercased and the
 * tunnel name and subdomain lowercased, with which of them a Wildflower
 * relay is given.
 */
interface CredentialsEntries {
  /**
   * A Wildflower relay's: a claim code; an access code, with an email and a
   * subdomain; or the tunnel name and token.
   */
  readonly kind: EnteredCredentials.Type['kind']
  /** A claim code or access code. */
  readonly claimCode: string
  /** An access code's email. */
  readonly email: string
  /** An access code's chosen tunnel name, blank for one the relay picks. */
  readonly subdomain: string
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
  remoteAddr: '',
  publicKey: '',
  ratholeDomain: '',
}

const NO_CREDENTIALS_ENTRIES: CredentialsEntries = {
  kind: 'claimCode',
  claimCode: '',
  email: '',
  subdomain: '',
  tunnelName: '',
  token: '',
}

/** The relay step's choices, by the kind of relay each enters. */
const RELAY_CHOICES = [
  { value: 'wildflowerOfficial', label: 'Wildflower official relay' },
  { value: 'selfHostedWildflower', label: 'A self-hosted Wildflower relay' },
  { value: 'rathole', label: 'A different reverse proxy' },
] as const

/** The domain the Wildflower official relay serves its tunnels under. */
const WILDFLOWER_RELAY_DOMAIN = 'relay.wildflowerhealth.io'

/** The doc on what a relay can and can't see of the traffic it passes. */
const RELAY_TRUST_MODEL_URL =
  'https://github.com/wildflowerhealthio/Wildflower/blob/main/docs/Relay/Explanation.md'

/**
 * The relay `entries` describe, each setting trimmed, or nothing while one
 * it needs is empty: a pin needs both its settings or neither, and a rathole
 * relay all three. The host checks the settings themselves.
 */
const enteredRelayOf = (entries: RelayEntries): Option.Option<EnteredRelay.Type> => {
  if (entries.choice === 'wildflowerOfficial') return Option.some({ kind: 'wildflowerOfficial' })
  const remoteAddr = entries.remoteAddr.trim()
  const publicKey = entries.publicKey.trim()
  if (entries.choice === 'rathole') {
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
    <p className={`text-body-3 ${styles['add-server-page__lead']}`}>{children}</p>
  </>
)

/** A rathole relay's `host:port` and noise public key fields. */
const RelayIdentityFields = ({
  entries,
  onChange,
}: {
  readonly entries: RelayEntries
  readonly onChange: (entries: RelayEntries) => void
}): JSX.Element => (
  <>
    <TextField
      label="Server address"
      value={entries.remoteAddr}
      onChange={(remoteAddr) => {
        onChange({ ...entries, remoteAddr })
      }}
      placeholder="relay.example.com:2333"
      description="The rathole server's host and port, which this device connects to."
    />
    <TextField
      label="Public key"
      value={entries.publicKey}
      onChange={(publicKey) => {
        onChange({ ...entries, publicKey })
      }}
      description="The rathole server's noise public key, as rathole --genkey prints it. It proves this device is talking to your server."
    />
  </>
)

/**
 * A self-hosted Wildflower relay's settings, after who can host one and
 * what any relay can see: its URL, and under Advanced its optional pin,
 * open while either half of it is entered.
 */
const SelfHostedRelaySettings = ({
  entries,
  onChange,
}: {
  readonly entries: RelayEntries
  readonly onChange: (entries: RelayEntries) => void
}): JSX.Element => {
  const [open, setOpen] = useState(() => entries.remoteAddr !== '' || entries.publicKey !== '')
  return (
    <>
      <p className={`text-body-3 ${styles['add-server-page__note']}`}>
        Anyone can host a Wildflower Relay. Everything sent through any relay is encrypted end to
        end between the app and your server. What a relay can see is which server is being reached,
        and when and from where.
      </p>
      <TextField
        label="Wildflower Relay URL"
        type="url"
        inputMode="url"
        value={entries.baseUrl}
        onChange={(baseUrl) => {
          onChange({ ...entries, baseUrl })
        }}
        placeholder="https://relay.example.com"
        description="The address of the Wildflower Relay."
      />
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
          <p className={`text-body-3 ${styles['add-server-page__note']}`}>
            Optionally, pin the relay: it must present this address and key, which are checked and
            not stored.
          </p>
          <RelayIdentityFields entries={entries} onChange={onChange} />
        </div>
      </details>
    </>
  )
}

/**
 * A rathole relay's settings, after what rathole is and what using it
 * directly takes: its identity and the domain it serves the server at.
 */
const RatholeRelaySettings = ({
  entries,
  onChange,
}: {
  readonly entries: RelayEntries
  readonly onChange: (entries: RelayEntries) => void
}): JSX.Element => (
  <>
    <p className={`text-body-3 ${styles['add-server-page__note']}`}>
      Wildflower internally uses an established open-source reverse proxy called{' '}
      <a href="https://github.com/rathole-org/rathole" target="_blank" rel="noreferrer">
        rathole
      </a>
      . You can use a rathole server you run yourself, instead of Wildflower Relay. It takes more
      setup by hand, and traffic is encrypted end to end just the same. Your connection to the
      server will be tested when the server starts.
    </p>
    <RelayIdentityFields entries={entries} onChange={onChange} />
    <TextField
      label="Tunnel domain"
      value={entries.ratholeDomain}
      onChange={(ratholeDomain) => {
        onChange({ ...entries, ratholeDomain: ratholeDomain.toLowerCase() })
      }}
      placeholder="relay.example.com"
      description="The domain your rathole server exposes tunnels at. Your server will be available at the tunnel name you enter next, followed by this domain."
    />
  </>
)

/**
 * Step 1, the relay: the Wildflower official relay, preselected, a
 * self-hosted Wildflower relay by its URL, with an optional pin, or a
 * rathole relay by its settings, either under Custom Relay Settings; over
 * what the relay can and can't see. Continue waits for every setting the
 * relay needs.
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
  const customHeadingId = useId()
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
        Apps on the web reach the server on this device through a relay.
      </StepHeading>
      <p className={`text-body-3 ${styles['add-server-page__note']}`}>
        Everything sent through the relay is encrypted end to end, between the app and your server,
        so the relay can't read your records. It can see which server is being reached, from where
        and when. For maximum security, you can host your own relay.{' '}
        <a href={RELAY_TRUST_MODEL_URL} target="_blank" rel="noreferrer">
          What a relay can and can't see
        </a>
      </p>
      <RadioGroup
        name="relay"
        legend="What kind of Relay are you using?"
        value={entries.choice}
        options={RELAY_CHOICES}
        onChange={(choice) => {
          onChange({ ...entries, choice })
        }}
      />
      {entries.choice === 'wildflowerOfficial' ? null : (
        <section className={styles['add-server-page__fields']} aria-labelledby={customHeadingId}>
          <h3 id={customHeadingId} className={`text-label-3 ${styles['add-server-page__title']}`}>
            Custom Relay Settings
          </h3>
          {entries.choice === 'selfHostedWildflower' ? (
            <SelfHostedRelaySettings entries={entries} onChange={onChange} />
          ) : (
            <RatholeRelaySettings entries={entries} onChange={onChange} />
          )}
        </section>
      )}
      <div className={styles['add-server-page__actions']}>
        <button type="submit" className="button-2 filled" disabled={Option.isNone(relay)}>
          Continue
        </button>
      </div>
    </form>
  )
}

/**
 * The domain the server is served under through `relay`: the official
 * relay's, a rathole relay's as entered, or nothing for a self-hosted
 * Wildflower relay, whose domain the host learns from it.
 */
const relayDomainOf = (relay: EnteredRelay.Type): Option.Option<string> =>
  Match.value(relay).pipe(
    Match.when({ kind: 'wildflowerOfficial' }, () => Option.some(WILDFLOWER_RELAY_DOMAIN)),
    Match.when({ kind: 'selfHostedWildflower' }, () => Option.none()),
    Match.when({ kind: 'rathole' }, ({ domain }) => Option.some(domain)),
    Match.exhaustive
  )

/**
 * The credentials `entries` give `relay`: for a Wildflower relay, the claim
 * code, the access code with its email and subdomain (left out when blank),
 * or the tunnel name and token, as `entries.kind` picks; for a rathole
 * relay, which redeems no codes, the tunnel name and token. Each as typed,
 * but a blank subdomain; the host trims them.
 */
const enteredCredentialsOf = (
  relay: EnteredRelay.Type,
  entries: CredentialsEntries
): EnteredCredentials.Type => {
  if (relay.kind === 'rathole' || entries.kind === 'token') {
    return { kind: 'token', tunnelName: entries.tunnelName, token: entries.token }
  }
  if (entries.kind === 'claimCode') return { kind: 'claimCode', code: entries.claimCode }
  const subdomain = entries.subdomain.trim()
  return {
    kind: 'accessCode',
    code: entries.claimCode,
    email: entries.email,
    ...(subdomain === '' ? {} : { tunnelName: subdomain }),
  }
}

/**
 * Whether `credentials` lack a value the host needs: a code that isn't one,
 * such as one missing a character, an access code's email left blank, or a
 * tunnel name or token left blank.
 */
const isIncomplete = (credentials: EnteredCredentials.Type): boolean =>
  Match.value(credentials).pipe(
    Match.when({ kind: 'claimCode' }, ({ code }) => !EnteredCredentials.isClaimCode(code)),
    Match.when(
      { kind: 'accessCode' },
      ({ code, email }) => !EnteredCredentials.isClaimCode(code) || email.trim() === ''
    ),
    Match.when(
      { kind: 'token' },
      ({ tunnelName, token }) => tunnelName.trim() === '' || token.trim() === ''
    ),
    Match.exhaustive
  )

/**
 * A claim code's field, uppercased as typed, saying the format Add server
 * waits for, over a note that the server's
 * address becomes public in the Certificate Transparency logs.
 */
const ClaimCodeFields = ({
  entries,
  onChange,
}: {
  readonly entries: CredentialsEntries
  readonly onChange: (entries: CredentialsEntries) => void
}): JSX.Element => (
  <>
    <TextField
      label="Claim code"
      value={entries.claimCode}
      onChange={(claimCode) => {
        onChange({ ...entries, claimCode: claimCode.toUpperCase() })
      }}
      placeholder="ABCD-EFGH"
      autoComplete="off"
      autoCapitalize="characters"
      description="Eight letters and digits, such as ABCD-EFGH; codes have no 0, 1, I, L or O. It works once: the relay exchanges it for your server's tunnel name and token, which are saved on this device."
    />
    <p className={`text-body-3 ${styles['add-server-page__note']}`}>
      Your server's address becomes public: when your server gets its certificate, the certificate
      authority records the address in the public Certificate Transparency logs, which nobody can
      remove it from.
    </p>
  </>
)

/**
 * An access code's fields: the code, uppercased as typed; the email the new
 * tunnel is for; and the subdomain, lowercased as typed, with the address it
 * gives the server through `relay`, or a note that the relay picks one when
 * it is blank, over a note that the address becomes public in the
 * Certificate Transparency logs.
 */
const AccessCodeFields = ({
  relay,
  entries,
  onChange,
}: {
  readonly relay: EnteredRelay.Type
  readonly entries: CredentialsEntries
  readonly onChange: (entries: CredentialsEntries) => void
}): JSX.Element => {
  const subdomain = entries.subdomain.trim()
  const domain = relayDomainOf(relay).pipe(Option.getOrElse(() => "[your relay's domain]"))
  return (
    <>
      <TextField
        label="Access code"
        value={entries.claimCode}
        onChange={(claimCode) => {
          onChange({ ...entries, claimCode: claimCode.toUpperCase() })
        }}
        autoComplete="off"
        autoCapitalize="characters"
        description="It works once: the relay exchanges it for a new tunnel for your server, whose name and token are saved on this device."
      />
      <TextField
        label="Your email"
        type="email"
        value={entries.email}
        onChange={(email) => {
          onChange({ ...entries, email })
        }}
        description="The relay's admin sees it beside your tunnel."
      />
      <TextField
        label="Subdomain (optional)"
        value={entries.subdomain}
        onChange={(chosen) => {
          onChange({ ...entries, subdomain: chosen.toLowerCase() })
        }}
        description={
          subdomain === ''
            ? 'Left empty, the relay picks one.'
            : `Your server will be available at ${subdomain}.${domain}`
        }
      />
      <p className={`text-body-3 ${styles['add-server-page__note']}`}>
        Your server's address becomes public: when your server gets its certificate, the certificate
        authority records the address in the public Certificate Transparency logs, which nobody can
        remove it from. Choose a subdomain you are happy to have public.
      </p>
    </>
  )
}

/**
 * The tunnel's name, with the address it gives the server through `relay`
 * and a note that the address becomes public in the Certificate
 * Transparency logs, and its token, masked.
 */
const TokenFields = ({
  relay,
  entries,
  onChange,
}: {
  readonly relay: EnteredRelay.Type
  readonly entries: CredentialsEntries
  readonly onChange: (entries: CredentialsEntries) => void
}): JSX.Element => {
  const name = entries.tunnelName.trim() === '' ? '[tunnel name]' : entries.tunnelName.trim()
  const domain = relayDomainOf(relay).pipe(Option.getOrElse(() => "[your relay's domain]"))
  return (
    <>
      <TextField
        label="Tunnel name"
        value={entries.tunnelName}
        onChange={(tunnelName) => {
          onChange({ ...entries, tunnelName: tunnelName.toLowerCase() })
        }}
        description={`Your server will be available at ${name}.${domain}`}
      />
      <p className={`text-body-3 ${styles['add-server-page__note']}`}>
        That address becomes public: when your server gets its certificate, the certificate
        authority records the address in the public Certificate Transparency logs, which nobody can
        remove it from. Choose a tunnel name you are happy to have public.
      </p>
      <TextField
        label="Tunnel token"
        type="password"
        value={entries.token}
        onChange={(token) => {
          onChange({ ...entries, token })
        }}
        description="This secret token is used to identify your device to the relay. The administrator of your relay should provide this to you. It's saved on this device and never shown again."
      />
    </>
  )
}

/**
 * Step 2, the tunnel. A Wildflower relay is given a claim code by default,
 * or, through a link between the fields and the buttons, the tunnel's name
 * and token, with a link back; a rathole relay only the name and token. A
 * code the relay answers as an access code comes back here, as an access
 * code, with an email and subdomain to enter. Add server waits for every
 * value they need.
 */
const CredentialsStep = ({
  relay,
  entries,
  onChange,
  onBack,
  onAdd,
}: {
  readonly relay: EnteredRelay.Type
  readonly entries: CredentialsEntries
  readonly onChange: (entries: CredentialsEntries) => void
  readonly onBack: () => void
  readonly onAdd: () => void
}): JSX.Element => {
  const headingId = useId()
  const credentials = enteredCredentialsOf(relay, entries)
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
        {Match.value(credentials.kind).pipe(
          Match.when('claimCode', () => "Enter the claim code from your relay's admin."),
          Match.when(
            'accessCode',
            () =>
              'That code is an access code: enter your email and choose a subdomain for your new server.'
          ),
          Match.when(
            'token',
            () => 'Enter the tunnel name and token you were given for this relay.'
          ),
          Match.exhaustive
        )}
      </StepHeading>
      {Match.value(credentials.kind).pipe(
        Match.when('claimCode', () => <ClaimCodeFields entries={entries} onChange={onChange} />),
        Match.when('accessCode', () => (
          <AccessCodeFields relay={relay} entries={entries} onChange={onChange} />
        )),
        Match.when('token', () => (
          <TokenFields relay={relay} entries={entries} onChange={onChange} />
        )),
        Match.exhaustive
      )}
      {relay.kind === 'rathole' ? null : (
        <LinkButton
          onClick={() => {
            onChange({ ...entries, kind: credentials.kind === 'token' ? 'claimCode' : 'token' })
          }}
        >
          {credentials.kind === 'token'
            ? 'I have a claim code'
            : 'I have a tunnel name and full length token'}
        </LinkButton>
      )}
      <div className={styles['add-server-page__actions']}>
        <button type="button" className="button-2 outline" onClick={onBack}>
          Back
        </button>
        <button type="submit" className="button-2 filled" disabled={isIncomplete(credentials)}>
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
            relay.kind === 'rathole' ? 'Checking the rathole settings…' : 'Checking with the relay…'
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
      <p className={`text-body-3 ${styles['add-server-page__lead']}`}>
        Apps reach your server at this address. The relay passes their traffic through without being
        able to read it. Start it now to run while Wildflower is open, or start it later from its
        page.
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
 * claim code or its name and token, the host's check and enrolment, and the
 * server added. A claim code the relay answers as an access code goes back
 * to the tunnel step as one, keeping the code, for an email and subdomain.
 *
 * @remarks
 * The steps and their entries live in this component's state, never the
 * URL, so neither the code nor the token reaches it; and once the host has
 * added the server, both are dropped from that state and from the
 * mutation's (see `useAddServer`). Back from a refusal keeps every entry.
 */
const AddServerPage = (): JSX.Element => {
  const runHostCommand = useRunHostCommand()
  const addServer = useAddServer(runHostCommand)
  const [step, setStep] = useState<Step>({ kind: 'relay' })
  const [relayEntries, setRelayEntries] = useState(NO_RELAY_ENTRIES)
  const [credentialsEntries, setCredentialsEntries] = useState(NO_CREDENTIALS_ENTRIES)
  const add = (relay: EnteredRelay.Type): void => {
    setStep({ kind: 'checking', relay })
    addServer.mutate(
      { relay, credentials: enteredCredentialsOf(relay, credentialsEntries) },
      {
        onSuccess: (domain) => {
          addServer.reset()
          setCredentialsEntries((entries) => ({ ...entries, claimCode: '', token: '' }))
          setStep({ kind: 'done', domain })
        },
        onError: (error) => {
          if (!asksForAccessCodeDetails(error)) return
          addServer.reset()
          setCredentialsEntries((entries) => ({ ...entries, kind: 'accessCode' }))
          setStep({ kind: 'credentials', relay })
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
        relay={relay}
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
      <PageHeader title="Add server" backHref="/servers" backLabel="Servers" />
      {body}
    </>
  )
}

export { AddServerPage }
