import { createFileRoute } from '@tanstack/react-router'
import { DateTime, Duration, Option } from 'effect'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, ErrorBanner, PageHeader, pageLayoutStyles } from 'react-tundraish'

import { activityCountsOf, activityEntryOf, refusedStreaksOf } from '../../../activity-feed.ts'
import { RelaySettingsEntry } from '../../../components/RelaySettingsEntry.tsx'
import { TunnelActivityFeed } from '../../../components/TunnelActivityFeed.tsx'
import { TunnelExplainer } from '../../../components/TunnelExplainer.tsx'
import { TunnelStatusHero } from '../../../components/TunnelStatusHero.tsx'
import {
  mightTunnelBeOpen,
  tunnelStateQueryOptions,
  useClientNames,
  useRecentRefusedRequestsQuery,
  useTunnelCallersQuery,
  useTunnelStateQuery,
  type TunnelState,
} from '../../../queries/index.ts'
import { useTunnelSettingsForm } from '../../../use-tunnel-settings-form.ts'
import styles from './index.module.css'

interface TunnelScreenBodyProps {
  readonly state: TunnelState
}

/** How often the activity card re-reads the request log while it's shown. */
const ACTIVITY_REFRESH_INTERVAL = Duration.seconds(10)

/** How many callers the activity card lists; the activity page has the rest. */
const ACTIVITY_FEED_LENGTH = 5

/**
 * The activity card, read live from the request log: the most recent callers,
 * the request counts, and refused streaks from the newest refused requests.
 * The log is secondary on this screen, so while it loads the card waits, and a
 * failed read shows in place of the card rather than failing the screen.
 */
const LiveActivityFeed = (): JSX.Element | null => {
  const live = { refetchInterval: Duration.toMillis(ACTIVITY_REFRESH_INTERVAL) }
  const callers = useTunnelCallersQuery(live)
  const refused = useRecentRefusedRequestsQuery(live)
  const names = useClientNames()

  if (callers.error !== null) return <ErrorBanner error={callers.error} />
  return Option.fromNullable(callers.data).pipe(
    Option.map((rows) => (
      <TunnelActivityFeed
        key="feed"
        entries={rows.slice(0, ACTIVITY_FEED_LENGTH).map((row) => activityEntryOf(row, names))}
        counts={activityCountsOf(rows)}
        streaks={refusedStreaksOf(refused.data ?? [], DateTime.unsafeNow())}
      />
    )),
    Option.getOrNull
  )
}

/**
 * The Tunnel overview screen — header + explainer + status hero +
 * recent-activity feed (when the tunnel is open) + a navigation entry
 * to the Relay settings detail page. The form for editing host/relay
 * + the Save / Test connection actions live on the Relay settings
 * page (`/settings/tunnel/relay`); this screen carries no form.
 *
 * The hero still owns the live Run-tunnel switch, so the overview uses the
 * shared `useTunnelSettingsForm` hook for its `toggle`/`pending` outputs and
 * for the toggle's mutation feedback (`errorMessage` / `conflicted`).
 */
const TunnelScreenBody = ({ state }: TunnelScreenBodyProps): JSX.Element => {
  const form = useTunnelSettingsForm(state)

  return (
    <>
      <PageHeader title="Tunnel" backHref="/settings" backLabel="Settings" />
      <TunnelExplainer state={state} />

      {form.pending ? (
        <TunnelStatusHero state={state} disabled />
      ) : (
        <TunnelStatusHero state={state} onToggle={form.toggle} />
      )}

      {/*
       * The Run-tunnel switch lives in the hero, so its mutation feedback
       * surfaces here rather than on the relay form: a failed toggle (transport
       * error) and a 409 (the tunnel changed on another device) would otherwise
       * be silently swallowed on this screen.
       */}
      {form.errorMessage !== null ? (
        <p className={cn(pageLayoutStyles['error'], 'text-body-3')} role="alert">
          {form.errorMessage}
        </p>
      ) : null}

      {form.conflicted ? (
        <p className={cn(styles['conflict'], 'text-body-3')} role="status">
          The tunnel was changed on another device — the latest state is shown above. Toggle again
          to apply your change.
        </p>
      ) : null}

      {mightTunnelBeOpen(state) ? <LiveActivityFeed /> : null}

      <RelaySettingsEntry />
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
    await context.queryClient.query({
      ...tunnelStateQueryOptions(context.runAuthed),
      staleTime: 'static',
    })
  },
  component: TunnelScreenContent,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Tunnel" />,
})
