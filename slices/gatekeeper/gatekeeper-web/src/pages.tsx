import { type HttpApiGroup, HttpApiBuilder } from '@effect/platform'
import type { Layer } from 'effect'
import { Effect } from 'effect'
import { GatekeeperApi } from 'gatekeeper-core/http-api-definition'
import { html as spaHtml } from 'gatekeeper-web/html'
import { renderToStaticMarkup } from 'react-dom/server'

const renderPollingPage = (id: string): string => {
  const statusUrl = `/oauth/authorize/${encodeURIComponent(id)}`
  const pollingScript = `(function poll() {
  fetch(${JSON.stringify(statusUrl)}, { credentials: 'same-origin' })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.status === 'approved' && typeof data.redirect === 'string') {
        window.location.replace(data.redirect);
      } else if (data.status === 'denied') {
        document.getElementById('spinner').className = 'gk-poll-hidden';
        document.getElementById('title').textContent = 'Request Declined';
        document.getElementById('title').className = 'gk-poll-declined';
        document.getElementById('message').textContent = 'The authorization request was declined.';
      } else if (data.status === 'error') {
        document.getElementById('spinner').className = 'gk-poll-hidden';
        document.getElementById('title').textContent = 'Authorization Error';
        document.getElementById('title').className = 'gk-poll-declined';
        document.getElementById('message').textContent = data.message || 'An error occurred.';
      } else {
        setTimeout(poll, 1500);
      }
    })
    .catch(function() { setTimeout(poll, 3000); });
})();`

  const pollingCss = `body { font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; color: #161616; }
.gk-poll-spinner { width: 40px; height: 40px; border: 3px solid #dedede; border-top-color: #3a81d7; border-radius: 50%; animation: gk-poll-spin 0.8s linear infinite; margin-bottom: 24px; }
@keyframes gk-poll-spin { to { transform: rotate(360deg); } }
h1 { font-size: 1.5em; font-weight: 500; margin-bottom: 8px; }
p { color: #636363; font-size: 1em; }
.gk-poll-declined { color: #c20010; }
.gk-poll-hidden { display: none; }`

  const markup = renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="referrer" content="no-referrer" />
        <title>Waiting for Approval</title>
        <style dangerouslySetInnerHTML={{ __html: pollingCss }} />
      </head>
      <body>
        <div className="gk-poll-spinner" id="spinner" />
        <h1 id="title">Waiting for Approval</h1>
        <p id="message">Please approve this request on your device.</p>
        <script dangerouslySetInnerHTML={{ __html: pollingScript }} />
      </body>
    </html>
  )

  return `<!DOCTYPE html>${markup}`
}

// SPA-shell pages share the prebuilt single-file bundle from
// `gatekeeper-web/html`; the only per-route variation is the injected
// `__INITIAL_ROUTE__` so MemoryRouter starts on the right screen.
const renderSpaShell = (route: string): string => {
  const injection = `<script>window.__INITIAL_ROUTE__=${JSON.stringify(route)};</script>`
  if (spaHtml.includes('<head>')) {
    return spaHtml.replace('<head>', `<head>${injection}`)
  }
  return injection + spaHtml
}

const oauthConsentRoute = (id: string): string => `/oauth-consent/${encodeURIComponent(id)}`

const deviceConsentRoute = (userCode: string): string => `/devices/${encodeURIComponent(userCode)}`

const GatekeeperPagesHandlersLive = HttpApiBuilder.group(
  GatekeeperApi,
  'gatekeeper-pages',
  (handlers) =>
    handlers
      .handle('OAuthPollingPage', ({ path: { id } }) => Effect.succeed(renderPollingPage(id)))
      .handle('OAuthConsentPage', ({ path: { id } }) =>
        Effect.succeed(renderSpaShell(oauthConsentRoute(id)))
      )
      .handle('DeviceEntryPage', () => Effect.succeed(renderSpaShell('/devices')))
      .handle('DeviceConsentPage', ({ path: { userCode } }) =>
        Effect.succeed(renderSpaShell(deviceConsentRoute(userCode)))
      )
)

// Phantom-id bridge: see gatekeeper-core's GatekeeperApiHandlersFor for the
// canonical long-form explanation. A Layer built against GatekeeperApi
// satisfies a parent ApiId's group requirement because
// `ApiGroup<ApiId, Name>` is a structural marker with no runtime presence.
type GatekeeperWebGroupNames = 'gatekeeper-pages'

const GatekeeperPagesHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, GatekeeperWebGroupNames>
> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  GatekeeperPagesHandlersLive as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, GatekeeperWebGroupNames>
  >

export { GatekeeperPagesHandlersFor, GatekeeperPagesHandlersLive }
