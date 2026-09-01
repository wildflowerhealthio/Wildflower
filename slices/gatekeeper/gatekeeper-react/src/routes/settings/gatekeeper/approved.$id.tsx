import { createFileRoute } from '@tanstack/react-router'
import { Match } from 'effect'
import type { JSX } from 'react'
import { AsyncErrorView, PageHeader } from 'react-tundraish'

import { formatInstant } from '../../../format-date.ts'
import { grantQueryOptions, useGrantQuery, type Grant } from '../../../queries/index.ts'
import pageLayout from '../../../styles/page-layout.module.css'

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
 * Presentational per-grant detail, shared by both list sections' links.
 * Prop-driven (no query hook) so it renders in tests without a live router.
 *
 * The grant union is narrowed with an effect `Match` on `grantType`
 * (`Match.exhaustive` turns a future variant into a compile error): a code-flow
 * grant surfaces its `redirectUri`, a device grant its `deviceName`. Keeping one
 * detail route for both variants mirrors apps' single `$id` screen — and avoids
 * colliding with the owner-facing `devices_.$userCode` consent route.
 */
const GrantDetailBody = ({ grant }: { readonly grant: Grant }): JSX.Element => {
  const scopes = grant.scopes.join(', ')
  const granted = formatInstant(grant.grantedAt)
  return Match.value(grant).pipe(
    Match.when({ grantType: 'authorization_code' }, (appGrant) => (
      <>
        <PageHeader title="Approved App" backHref="/settings/gatekeeper" backLabel="Access" />
        <div className={pageLayout['section']}>
          <GrantField label="Client" value={appGrant.clientId} />
          <GrantField label="Redirect URI" value={appGrant.redirectUri} />
          <GrantField label="Scopes" value={scopes} />
          <GrantField label="Granted" value={granted} />
        </div>
      </>
    )),
    Match.when({ grantType: 'device_code' }, (deviceGrant) => (
      <>
        <PageHeader title="Authorized Device" backHref="/settings/gatekeeper" backLabel="Access" />
        <div className={pageLayout['section']}>
          <GrantField label="Device" value={deviceGrant.deviceName} />
          <GrantField label="Client" value={deviceGrant.clientId} />
          <GrantField label="Scopes" value={scopes} />
          <GrantField label="Granted" value={granted} />
        </div>
      </>
    )),
    Match.exhaustive
  )
}

const GrantDetailScreen = ({ id }: { readonly id: string }): JSX.Element => {
  const { data: grant } = useGrantQuery(id)
  return <GrantDetailBody grant={grant} />
}

/**
 * The `/settings/gatekeeper/approved/$id` file route — the shared detail screen
 * for both grant variants. Reads the typed `$id` path param and hands it to the
 * screen. The `_auth` / `/settings` `beforeLoad` gate guarantees a token before
 * this loader runs, so it's a plain `ensureQueryData` — failures propagate to
 * the route's `errorComponent`.
 */
function GrantDetailRoute(): JSX.Element {
  const { id } = Route.useParams()
  return <GrantDetailScreen id={id} />
}

const Route = createFileRoute('/settings/gatekeeper/approved/$id')({
  loader: ({ context, params }) =>
    context.queryClient.query({
      ...grantQueryOptions(context.runAuthed, params.id),
      staleTime: 'static',
    }),
  component: GrantDetailRoute,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Not Found" />,
})

export { GrantDetailBody, Route }
