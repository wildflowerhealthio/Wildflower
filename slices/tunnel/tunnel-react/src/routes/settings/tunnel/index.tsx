import { createFileRoute } from '@tanstack/react-router'
import { DateTime } from 'effect'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { AsyncErrorView, PageHeader, pageLayoutStyles } from 'react-tundraish'

import { RelaySettingsEntry } from '../../../components/RelaySettingsEntry.tsx'
import { TunnelActivityFeed, type ActivityEntry } from '../../../components/TunnelActivityFeed.tsx'
import { TunnelExplainer } from '../../../components/TunnelExplainer.tsx'
import { TunnelStatusHero } from '../../../components/TunnelStatusHero.tsx'
import {
  mightTunnelBeOpen,
  tunnelStateQueryOptions,
  useTunnelStateQuery,
  type TunnelState,
} from '../../../queries.ts'
import { useTunnelSettingsForm } from '../../../use-tunnel-settings-form.ts'
import styles from './index.module.css'

interface TunnelScreenBodyProps {
  readonly state: TunnelState
}

/*
 * Sham activity feed entries. The real source (connection-log query
 * against the daemon) is a future slice; until then the screen renders
 * a fixed set of plausible events so the layout/design can be reviewed
 * with real-shaped data. Generated at call time so the relative times
 * stay anchored to "now".
 */
const buildShamActivityEntries = (): readonly ActivityEntry[] => {
  const now = DateTime.unsafeNow()
  return [
    {
      name: 'Collector',
      location: "Ruth's iPhone",
      lastConnectionAt: now,
      state: 'active',
    },
    {
      name: 'Patient app',
      location: '198.51.100.24',
      lastConnectionAt: DateTime.subtract(now, { minutes: 2 }),
      state: 'active',
    },
    {
      name: 'Unknown client',
      location: '203.0.113.9',
      lastConnectionAt: DateTime.subtract(now, { hours: 1 }),
      message: 'not authorized',
      state: 'error',
    },
  ]
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

      {mightTunnelBeOpen(state) ? (
        <TunnelActivityFeed entries={buildShamActivityEntries()} />
      ) : null}

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
    await context.queryClient.ensureQueryData(tunnelStateQueryOptions(context.runAuthed))
  },
  component: TunnelScreenContent,
  errorComponent: ({ error }) => <AsyncErrorView error={error} title="Tunnel" />,
})
