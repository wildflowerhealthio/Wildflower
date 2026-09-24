import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { addOsColorSchemeListener } from 'react-tundraish'

import {
  authorizeSmartLaunch,
  launchErrorBodyFor,
  launchErrorRedirect,
  type SmartLaunchConfig,
} from 'fhir-r4-react/smart'
import { LaunchPage } from './launch-page.tsx'

/** Configuration for {@link runSmartLaunchEntry}. */
interface SmartLaunchEntryConfig {
  /**
   * The SMART registration the EHR launch authorizes with. `iss` / `launch`
   * come from the launch URL and the redirect URI is derived from it, so
   * neither is part of it.
   */
  readonly launch: Omit<SmartLaunchConfig, 'redirectUri' | 'iss'>
  /** The one line the launch page shows while discovery is in flight, e.g. `Launching Importer…`. */
  readonly loadingMessage: string
}

/**
 * Authorize an EHR launch from the launch page at `launchPageHref`, resolving
 * to where the page must go if the launch fails before it leaves.
 *
 * @returns `null` when the authorize redirect is under way (in practice the
 *   promise never settles then — the page navigates away), or the app-root URL
 *   carrying the failure as `?launchError` when `authorizeSmartLaunch` rejects.
 *
 * @remarks
 * The OAuth redirect target is the app's root, which serves `index.html`,
 * derived from the launch page URL so it works at whatever origin and path the
 * bundle is served from. A launch that never reaches the authorization server
 * fails here — an unreachable or CORS-blocked `iss`, a server that serves no
 * SMART config, a client id or redirect URI the server does not know. The
 * launch page has no UI to report that in, so the failure goes to the app root,
 * whose `ErrorBanner` does.
 */
const authorizeFromLaunchPage = async (
  launch: SmartLaunchEntryConfig['launch'],
  launchPageHref: string
): Promise<string | null> => {
  const redirectUri = new URL('.', launchPageHref).href
  const search = new URL(launchPageHref).search
  try {
    await authorizeSmartLaunch({ ...launch, redirectUri })
    return null
  } catch (error: unknown) {
    return launchErrorRedirect(redirectUri, launchErrorBodyFor('AuthorizeFailed', error, search))
  }
}

/**
 * The whole body of a self-hosted SMART app's `launch.html` entry: mirror the
 * OS colour scheme, mount the launch page into `#root`, and start the EHR
 * launch — sending a failed one back to the app root.
 *
 * @remarks
 * The page is {@link LaunchPage}, mounted before the authorize
 * call so the page is never blank while discovery is in flight. The colour
 * scheme listener runs first so the page does not flash light before the app
 * root picks the scheme up. The entry imports
 * `react-tundraish/styles` itself, before calling this.
 *
 * @returns Settles once a failed launch has been handed to the app root; on a
 *   successful authorize the page navigates away first.
 */
const runSmartLaunchEntry = async ({
  launch,
  loadingMessage,
}: SmartLaunchEntryConfig): Promise<void> => {
  addOsColorSchemeListener()

  const container = document.getElementById('root')
  if (container !== null) {
    createRoot(container).render(
      createElement(StrictMode, null, createElement(LaunchPage, { message: loadingMessage }))
    )
  }

  const failure = await authorizeFromLaunchPage(launch, window.location.href)
  if (failure !== null) window.location.replace(failure)
}

export { authorizeFromLaunchPage, runSmartLaunchEntry, type SmartLaunchEntryConfig }
