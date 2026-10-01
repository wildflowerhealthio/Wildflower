import { createFileRoute, useRouter } from '@tanstack/react-router'
import { appTileStyles } from 'apps-react'
import { APP_DESCRIPTIONS, siteRootFor, smartAppLaunchPages } from 'branding-core'
import { appLaunchUrl, type AppLaunchServer } from 'fhir-r4-react/smart'
import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'
import { PageHeader, pageLayoutStyles } from 'react-tundraish'

import type { RouterContext } from '../router-context.ts'
import { plainSmartRouteOptions } from '../session/auth-gated-route-options.ts'
import { ServerKind } from '../session/server-kind.ts'
import { AppTabShell } from '../session/tab-bar.tsx'

/** Props for {@link FhirServerHome}. */
interface FhirServerHomeProps {
  /** The server the session is for, and the patient its token put in context. */
  readonly server: AppLaunchServer
  /**
   * The slash-terminated root of the copy of the site the apps are linked on
   * (`branding-core`'s `siteRootFor`): the published site, or the PR preview
   * this owner UI is part of.
   */
  readonly siteRoot: string
}

/**
 * Home on a plain SMART server: what the owner UI shows once `main-web` has
 * signed in to a SMART on FHIR server that is not a Wildflower server. It names
 * the FHIR base the session is for and lists every first-party SMART app the
 * site hosts (`branding-core`'s `smartAppLaunchPages`), each a tile linking to
 * the app launched against that server (`fhir-r4-react`'s `appLaunchUrl`): an
 * EHR launch through SMART Health IT's launcher, with the session's patient,
 * for one of its servers, and a standalone launch for any other.
 *
 * @remarks
 * The list is static, so nothing here calls the server. The tiles are the apps
 * home's (`apps-react`'s `appTileStyles`), as plain links: a click opens the
 * app in this tab, and a modified click or the context menu opens a new one.
 *
 * Presentational and prop-driven, like `settings/index.tsx`'s `SettingsIndex`,
 * so it mounts in a test without the app's router context.
 */
function FhirServerHome({ server, siteRoot }: FhirServerHomeProps): JSX.Element {
  return (
    <AppTabShell>
      <div className={pageLayoutStyles['page']}>
        <PageHeader title="Home" />
        <p>
          You are signed in to <code>{server.fhirBaseUrl}</code>, a SMART on FHIR server rather than
          a Wildflower server, so Wildflower specific features aren’t available here. You can launch
          any of Wildflower’s apps against it.
        </p>
        <ul className={appTileStyles['app-tiles']} aria-label="Apps">
          {smartAppLaunchPages(siteRoot).map(({ app, launchPageUrl }) => (
            <li key={app} className={appTileStyles['app-tile']}>
              <a
                href={appLaunchUrl(launchPageUrl, server)}
                className={cn(appTileStyles['app-tile__body'], appTileStyles['app-tile__launch'])}
                rel="nofollow noreferrer"
              >
                <span className={appTileStyles['app-tile__head']}>
                  <span className={cn(appTileStyles['app-tile__name'], 'text-body-2')}>
                    {APP_DESCRIPTIONS[app].name}
                  </span>
                  <span className={cn(appTileStyles['app-tile__subtitle'], 'text-body-3')}>
                    {APP_DESCRIPTIONS[app].tagline}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </AppTabShell>
  )
}

/**
 * Route binding: reads the server the tree was built for and where this copy of
 * the owner UI is served, and hands them to {@link FhirServerHome}. The site
 * root comes from the page's origin and the router's basepath, so a PR
 * preview's owner UI links that preview's apps. `plainSmartRouteOptions` has
 * already redirected a Wildflower server's session to `/home`, so the
 * `Wildflower` arm is never rendered.
 */
function FhirServerHomeRoute(): JSX.Element {
  const serverKind = Route.useRouteContext({
    select: (context: RouterContext) => context.serverKind,
  })
  const { basepath } = useRouter()
  const siteRoot = siteRootFor('app', new URL(basepath, window.location.origin).href)
  return ServerKind.$match(serverKind, {
    PlainSmart: (server) => <FhirServerHome server={server} siteRoot={siteRoot} />,
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
