import { createFileRoute, Link } from '@tanstack/react-router'
import { DateTime, Match, Option, Schema } from 'effect'
import { formatBytes, formatRelativeTime } from 'kitchen-sink'
import { useId, useState, type JSX } from 'react'
import { cn, pagedQueryStatusOf } from 'react-kitchen-sink'
import {
  AsyncErrorView,
  ErrorBanner,
  Field,
  PageHeader,
  PageLoading,
  TextField,
} from 'react-tundraish'
import { Tunnel } from 'tunnel-core/http-api-definition'

import {
  useClientNames,
  useExportRequestsMutation,
  useTunnelCallersQuery,
  useTunnelRequestsQuery,
  type CallerSummary,
  type LoggedRequest,
} from '../../../queries.ts'
import { REQUEST_LOG_CSV_FILE_NAME, requestLogCsv, saveCsv } from '../../../request-log-csv.ts'
import {
  accessLabelOf,
  AUTH_LABELS,
  callerNameOf,
  clientActivityOf,
  clientNameOf,
  requestAccessOf,
} from '../../../request-log.ts'
import { writeToClipboard } from '../../../write-to-clipboard.ts'
import styles from './activity.module.css'

/**
 * The `/settings/tunnel/activity` search: the request-log filter, every field
 * optional and every one given narrowing the log (see `ListRequests`).
 */
const ActivitySearch = Schema.Struct({
  client: Schema.optional(Schema.String),
  address: Schema.optional(Schema.String),
  auth: Schema.optional(Tunnel.RequestAuthSchema),
})
type ActivitySearch = Schema.Schema.Type<typeof ActivitySearch>

/** An access select's value as an `auth` case; the empty "All requests" option is none. */
const decodeAuth = Schema.decodeUnknownOption(Tunnel.RequestAuthSchema)

const formatReceivedAt = (receivedAt: DateTime.Utc): string =>
  DateTime.formatLocal(receivedAt, { dateStyle: 'medium', timeStyle: 'medium' })

interface ClientOption {
  readonly clientId: string
  readonly name: string
}

/**
 * The clients the filter offers: every verified caller the log holds, plus the
 * one filtered to when the log no longer holds it. Requests with no verified
 * caller have no `clientId` to filter on; the access filter and the address
 * reach them instead.
 */
const clientOptionsOf = (
  callers: readonly CallerSummary[],
  selected: string | undefined,
  names: ReadonlyMap<string, string>
): readonly ClientOption[] =>
  [
    ...new Set([
      ...callers.flatMap((caller) => Option.toArray(caller.clientId)),
      ...(selected === undefined ? [] : [selected]),
    ]),
  ]
    .map((clientId) => ({ clientId, name: clientNameOf(clientId, names) }))
    .toSorted((a, b) => a.name.localeCompare(b.name))

interface ActivityFiltersProps {
  readonly search: ActivitySearch
  readonly clientOptions: readonly ClientOption[]
  readonly onChange: (next: ActivitySearch) => void
}

/**
 * The filter row. The client and access selects apply at once; the address
 * applies on submit, so the log isn't re-read per keystroke.
 */
const ActivityFilters = ({
  search,
  clientOptions,
  onChange,
}: ActivityFiltersProps): JSX.Element => {
  const [address, setAddress] = useState(search.address ?? '')
  const clientSelectId = useId()
  const authSelectId = useId()

  return (
    <form
      className={styles['activity__filters']}
      onSubmit={(event) => {
        event.preventDefault()
        const trimmed = address.trim()
        onChange({ ...search, address: trimmed === '' ? undefined : trimmed })
      }}
    >
      <Field label="Client" htmlFor={clientSelectId}>
        <select
          id={clientSelectId}
          className="input-2"
          value={search.client ?? ''}
          onChange={(event) => {
            const clientId = event.target.value
            onChange({ ...search, client: clientId === '' ? undefined : clientId })
          }}
        >
          <option value="">All clients</option>
          {clientOptions.map((option) => (
            <option key={option.clientId} value={option.clientId}>
              {option.name}
            </option>
          ))}
        </select>
      </Field>
      <TextField
        label="Address"
        inputMode="url"
        placeholder="203.0.113.9"
        value={address}
        onChange={setAddress}
      />
      <Field label="Access" htmlFor={authSelectId}>
        <select
          id={authSelectId}
          className="input-2"
          value={search.auth ?? ''}
          onChange={(event) => {
            onChange({ ...search, auth: Option.getOrUndefined(decodeAuth(event.target.value)) })
          }}
        >
          <option value="">All requests</option>
          {Tunnel.RequestAuthSchema.literals.map((auth) => (
            <option key={auth} value={auth}>
              {AUTH_LABELS[auth]}
            </option>
          ))}
        </select>
      </Field>
      <button type="submit" className="button-2 outline">
        Filter
      </button>
    </form>
  )
}

interface ClientSummaryProps {
  readonly name: string
  readonly clientId: string
  /** `ListCallers`' rows, `undefined` until they've been read. */
  readonly callers: readonly CallerSummary[] | undefined
}

const describeClientActivity = (callers: readonly CallerSummary[], clientId: string): string =>
  clientActivityOf(callers, clientId).pipe(
    Option.map((activity) => {
      const now = DateTime.unsafeNow()
      return [
        `${activity.requestCount} ${activity.requestCount === 1 ? 'request' : 'requests'}`,
        `${activity.refusedCount} refused`,
        `${activity.addressCount} ${activity.addressCount === 1 ? 'address' : 'addresses'}`,
        `first seen ${formatRelativeTime(activity.firstSeen, now)}`,
        `last seen ${formatRelativeTime(activity.lastSeen, now)}`,
      ].join(' · ')
    }),
    Option.getOrElse(() => 'No requests from this client in the log.')
  )

/** The header shown when the log is filtered to one client. */
const ClientSummary = ({ name, clientId, callers }: ClientSummaryProps): JSX.Element => (
  <section className={styles['activity__summary']} aria-label="Client summary">
    <h2 className={cn(styles['activity__summary-name'], 'text-heading-5')}>{name}</h2>
    {Option.fromNullable(callers).pipe(
      Option.map((rows) => (
        <p key="line" className={styles['activity__summary-line']}>
          {describeClientActivity(rows, clientId)}
        </p>
      )),
      Option.getOrNull
    )}
  </section>
)

interface AddressPanelProps {
  readonly address: string
}

/** The header shown when the log is filtered to one address. */
const AddressPanel = ({ address }: AddressPanelProps): JSX.Element => (
  <section className={styles['activity__address']} aria-label="Address">
    <span className={styles['activity__address-value']}>{address}</span>
    <div className={styles['activity__address-actions']}>
      <button
        type="button"
        className="button-2 outline"
        onClick={() => {
          void writeToClipboard(address)
        }}
      >
        Copy address
      </button>
      <button
        type="button"
        className="button-2 outline"
        disabled
        title="Blocking an address isn't available yet."
      >
        Block this address
      </button>
    </div>
  </section>
)

interface RequestRowProps {
  readonly request: LoggedRequest
  readonly search: ActivitySearch
  readonly names: ReadonlyMap<string, string>
}

/**
 * One logged request. The client and address cells narrow the log to that
 * value, keeping the rest of the filter.
 */
const RequestRow = ({ request, search, names }: RequestRowProps): JSX.Element => {
  const name = callerNameOf(request.clientId, names)
  const access = requestAccessOf(request)
  return (
    <tr
      className={cn(
        styles['activity__row'],
        access.auth === 'refused' ? styles['activity__row--refused'] : null
      )}
    >
      <td className={styles['activity__time']}>{formatReceivedAt(request.receivedAt)}</td>
      <td>
        {request.clientId.pipe(
          Option.map((clientId) => (
            <Link key="client" to={Route.fullPath} search={{ ...search, client: clientId }}>
              {name}
            </Link>
          )),
          Option.getOrElse(() => name)
        )}
      </td>
      <td className={styles['activity__mono']}>
        {request.address.pipe(
          Option.map((address) => (
            <Link key="address" to={Route.fullPath} search={{ ...search, address }}>
              {address}
            </Link>
          )),
          Option.getOrElse(() => '—')
        )}
      </td>
      <td className={styles['activity__mono']}>
        {request.method} {request.path}
      </td>
      <td>{accessLabelOf(access)}</td>
      <td className={styles['activity__number']}>{request.status}</td>
      <td className={styles['activity__number']}>
        {request.responseBytes.pipe(
          Option.map(formatBytes),
          Option.getOrElse(() => '—')
        )}
      </td>
      <td className={styles['activity__number']}>{request.durationMs} ms</td>
    </tr>
  )
}

interface RequestTableProps {
  readonly requests: readonly LoggedRequest[]
  readonly search: ActivitySearch
  readonly names: ReadonlyMap<string, string>
}

const RequestTable = ({ requests, search, names }: RequestTableProps): JSX.Element =>
  requests.length === 0 ? (
    <p className={styles['activity__empty']}>No requests match these filters.</p>
  ) : (
    <div className={styles['activity__table-scroll']}>
      <table className={cn(styles['activity__table'], 'text-body-3')}>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Client</th>
            <th scope="col">Address</th>
            <th scope="col">Request</th>
            <th scope="col">Access</th>
            <th scope="col">Status</th>
            <th scope="col">Size</th>
            <th scope="col">Duration</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((request) => (
            <RequestRow key={request.id} request={request} search={search} names={names} />
          ))}
        </tbody>
      </table>
    </div>
  )

/**
 * The request log, newest first: filters, a header for the client or address
 * filtered to, a CSV export of everything the filter matches, and the table,
 * read a page at a time behind a "Load more" button.
 */
const ActivityScreen = (): JSX.Element => {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const names = useClientNames()
  const callers = useTunnelCallersQuery().data
  const requests = useTunnelRequestsQuery(search)
  const exportRequests = useExportRequestsMutation()
  const filtered =
    search.client !== undefined || search.address !== undefined || search.auth !== undefined

  const loadMoreButton = (pending: boolean): JSX.Element => (
    <button
      type="button"
      className={cn('button-2 outline', styles['activity__more'])}
      disabled={pending}
      onClick={() => {
        void requests.fetchNextPage()
      }}
    >
      {pending ? 'Loading…' : 'Load more'}
    </button>
  )
  const table = (footer: JSX.Element | null): JSX.Element => (
    <>
      <RequestTable
        requests={(requests.data?.pages ?? []).flatMap((page) => page.requests)}
        search={search}
        names={names}
      />
      {footer}
    </>
  )

  return (
    <>
      <PageHeader title="Activity" backHref="/settings/tunnel" backLabel="Tunnel" />

      <ActivityFilters
        // Remount on a filter change from elsewhere (a row link, "Clear
        // filters") so the address draft follows the URL.
        key={search.address ?? ''}
        search={search}
        clientOptions={clientOptionsOf(callers ?? [], search.client, names)}
        onChange={(next) => {
          void navigate({ search: next })
        }}
      />

      {Option.fromNullable(search.client).pipe(
        Option.map((clientId) => (
          <ClientSummary
            key="client-summary"
            name={clientNameOf(clientId, names)}
            callers={callers}
            clientId={clientId}
          />
        )),
        Option.getOrNull
      )}
      {Option.fromNullable(search.address).pipe(
        Option.map((address) => <AddressPanel key="address" address={address} />),
        Option.getOrNull
      )}

      <div className={styles['activity__actions']}>
        {filtered ? (
          <Link className={styles['activity__clear']} to={Route.fullPath} search={{}}>
            Clear filters
          </Link>
        ) : null}
        <button
          type="button"
          className="button-2 outline"
          disabled={exportRequests.isPending}
          onClick={() => {
            exportRequests.mutate(search, {
              onSuccess: (every) => {
                saveCsv(requestLogCsv(every, names), REQUEST_LOG_CSV_FILE_NAME)
              },
            })
          }}
        >
          {exportRequests.isPending ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>
      <ErrorBanner error={exportRequests.error} />

      {Match.value(pagedQueryStatusOf(requests)).pipe(
        Match.when({ kind: 'loading' }, () => <PageLoading />),
        Match.when({ kind: 'failed' }, ({ error }) => <ErrorBanner error={error} />),
        Match.when({ kind: 'paging' }, ({ isFetchingNextPage }) =>
          table(loadMoreButton(isFetchingNextPage))
        ),
        Match.when({ kind: 'page-failed' }, ({ error }) =>
          table(
            <>
              <ErrorBanner error={error} />
              {loadMoreButton(false)}
            </>
          )
        ),
        Match.when({ kind: 'complete' }, () => table(null)),
        Match.exhaustive
      )}
    </>
  )
}

/**
 * No loader: the log is read a page at a time as the screen asks, and a failed
 * read renders in place (see `pagedQueryStatusOf`) rather than replacing the
 * page with the `errorComponent`, which is left to an invalid search.
 */
const Route = createFileRoute('/settings/tunnel/activity')({
  validateSearch: Schema.standardSchemaV1(ActivitySearch),
  component: ActivityScreen,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Activity" />,
})

export { ActivitySearch, Route }
