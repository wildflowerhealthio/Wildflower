import { createFileRoute } from '@tanstack/react-router'
import type { JSX } from 'react'
import { PageHeader, pageLayoutStyles } from 'react-tundraish'

import type { RouterContext } from '../router-context.ts'
import { plainSmartRouteOptions } from '../session/auth-gated-route-options.ts'
import { ServerKind } from '../session/server-kind.ts'
import { AppTabShell } from '../session/tab-bar.tsx'

/**
 * Home on a plain SMART server: what the owner UI shows once `main-web` has
 * signed in to a SMART on FHIR server that is not a Wildflower server. It says
 * so, and names the FHIR base the session is for. Nothing here calls the
 * server.
 *
 * Presentational and prop-driven, like `settings/index.tsx`'s `SettingsIndex`,
 * so it mounts in a test without the app's router context.
 */
function FhirServerHome({ fhirBaseUrl }: { readonly fhirBaseUrl: string }): JSX.Element {
  return (
    <AppTabShell>
      <div className={pageLayoutStyles['page']}>
        <PageHeader title="Home" />
        <p>
          You are signed in to <code>{fhirBaseUrl}</code>, a SMART on FHIR server rather than a
          Wildflower server, so Wildflower specific features aren’t available here.
        </p>
      </div>
    </AppTabShell>
  )
}

/**
 * Route binding: reads the server the tree was built for and hands it to
 * {@link FhirServerHome}. `plainSmartRouteOptions` has already redirected a
 * Wildflower server's session to `/home`, so the `Wildflower` arm is never
 * rendered.
 */
function FhirServerHomeRoute(): JSX.Element {
  const serverKind = Route.useRouteContext({
    select: (context: RouterContext) => context.serverKind,
  })
  return ServerKind.$match(serverKind, {
    PlainSmart: ({ fhirBaseUrl }) => <FhirServerHome fhirBaseUrl={fhirBaseUrl} />,
    Wildflower: () => <></>,
  })
}

/**
 * `/fhir-home` — a root-level sibling of `_auth`, like `/settings`, because
 * every route under `_auth` is a Wildflower server's. It gates itself with
 * `plainSmartRouteOptions`: the same bearer-token gate, then a redirect to
 * `/home` for a Wildflower server's session.
 */
const Route = createFileRoute('/fhir-home')({
  ...plainSmartRouteOptions,
  component: FhirServerHomeRoute,
})

export { FhirServerHome, FhirServerHomeRoute, Route }
