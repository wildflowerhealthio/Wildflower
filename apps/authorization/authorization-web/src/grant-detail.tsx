import { useQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { Client } from '@wildflowerhealthio/authorization-core/domain'
import {
  clientsQueryOptions,
  formatInstant,
  useGrantQuery,
  type Grant,
} from '@wildflowerhealthio/authorization-react'
import { PageHeader } from '@wildflowerhealthio/react-tundraish'
import { Match, Option } from 'effect'
import type { JSX } from 'react'

import type { RouterContext } from './router-context.ts'
import { SessionLifetimeSection } from './session-lifetime.tsx'
import styles from './grant-detail.module.css'

/** One labeled read-only line in the grant detail. */
const GrantField = ({
  label,
  value,
}: {
  readonly label: string
  readonly value: string
}): JSX.Element => (
  <span className="text-body-3">
    <strong className="text-label-3">{label}:</strong> <span>{value}</span>
  </span>
)

/**
 * One grant, read only, for either list's link. The grant union is narrowed
 * with an effect `Match` on `grantType` (`Match.exhaustive` turns a new
 * variant into a compile error): an app's grant shows its `redirectUri`, a
 * device's its `deviceName`. Both name the client and give its id. Prop-driven, so it renders in tests without a
 * live router.
 */
const GrantDetailBody = ({
  grant,
  clientName,
}: {
  readonly grant: Grant
  /** The client's registered name, or its id while the trusted apps load. */
  readonly clientName: string
}): JSX.Element => {
  const scopes = grant.scopes.join(', ')
  const granted = formatInstant(grant.grantedAt)
  return Match.value(grant).pipe(
    Match.when({ grantType: 'authorization_code' }, (appGrant) => (
      <>
        <PageHeader title="Approved App" backHref="/" backLabel="Access" />
        <div className={styles['grant-detail']}>
          <GrantField label="App" value={clientName} />
          <GrantField label="Client ID" value={appGrant.clientId} />
          <GrantField label="Redirect URI" value={appGrant.redirectUri} />
          <GrantField label="Scopes" value={scopes} />
          <GrantField label="Granted" value={granted} />
        </div>
      </>
    )),
    Match.when({ grantType: 'device_code' }, (deviceGrant) => (
      <>
        <PageHeader title="Authorized Device" backHref="/" backLabel="Access" />
        <div className={styles['grant-detail']}>
          <GrantField label="Device" value={deviceGrant.deviceName} />
          <GrantField label="App" value={clientName} />
          <GrantField label="Client ID" value={deviceGrant.clientId} />
          <GrantField label="Scopes" value={scopes} />
          <GrantField label="Granted" value={granted} />
        </div>
      </>
    )),
    Match.exhaustive
  )
}

/**
 * The grant detail over the grant its loader warmed, with its client's
 * "Session lifetime" once the trusted apps have loaded.
 */
const GrantDetail = ({ id }: { readonly id: string }): JSX.Element => {
  const { data: grant } = useGrantQuery(id)
  const runAuthed = useRouteContext({
    from: '__root__',
    select: (context: RouterContext) => context.runAuthed,
  })
  const { data: clients } = useQuery(clientsQueryOptions(runAuthed))
  const client = Option.fromNullable(clients?.find(({ clientId }) => clientId === grant.clientId))
  return (
    <>
      <GrantDetailBody grant={grant} clientName={Client.displayName(clients, grant.clientId)} />
      {client.pipe(
        Option.map((loaded) => <SessionLifetimeSection key={loaded.clientId} client={loaded} />),
        Option.getOrNull
      )}
    </>
  )
}

export { GrantDetail, GrantDetailBody }
