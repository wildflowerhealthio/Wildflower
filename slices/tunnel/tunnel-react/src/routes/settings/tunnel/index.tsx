import { createFileRoute } from '@tanstack/react-router'
import type { JSX } from 'react'
import { AsyncErrorView, PageHeader } from 'react-tundraish'

import { TunnelExplainer } from '../../../components/TunnelExplainer.tsx'
import { TunnelStatusHero } from '../../../components/TunnelStatusHero.tsx'
import { tunnelStateQueryOptions, useTunnelStateQuery } from '../../../queries/index.ts'

/**
 * The Tunnel screen — header + explainer + status hero, read-only. The base
 * owns the server's tunnel settings, so the web app shows the tunnel's state
 * and changes nothing.
 */
const TunnelScreenContent = (): JSX.Element => {
  const { data: state } = useTunnelStateQuery()
  return (
    <>
      <PageHeader title="Tunnel" backHref="/settings" backLabel="Settings" />
      <TunnelExplainer />
      <TunnelStatusHero state={state} />
    </>
  )
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
