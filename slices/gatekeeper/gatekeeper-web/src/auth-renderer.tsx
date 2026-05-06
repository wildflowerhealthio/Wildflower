import { HttpServerResponse } from '@effect/platform'
import { Layer } from 'effect'
import { type AuthRendererInterface, AuthRenderer } from 'gatekeeper-core/contexts'
import { renderToStaticMarkup } from 'react-dom/server'

const authRenderer: AuthRendererInterface = {
  oauthPollingPage: ({ clientId, statusUrl }) => {
    const pollingScript = `(function poll() {
  fetch('${statusUrl}')
    .then(r => r.json())
    .then(data => {
      if (data.status === 'approved' && data.redirect) {
        window.location.href = data.redirect;
      } else if (data.status === 'declined') {
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('title').textContent = 'Request Declined';
        document.getElementById('title').className = 'declined';
        document.getElementById('message').textContent = 'The authorization request was declined.';
      } else {
        setTimeout(poll, 1500);
      }
    })
    .catch(() => setTimeout(poll, 3000));
})();`

    const pollingCss = `body { font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; color: #161616; }
.spinner { width: 40px; height: 40px; border: 3px solid #dedede; border-top-color: #3a81d7; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 24px; }
@keyframes spin { to { transform: rotate(360deg); } }
h1 { font-size: 1.5em; font-weight: 500; margin-bottom: 8px; }
p { color: #636363; font-size: 1em; }
.declined { color: #c20010; }`

    const pollingMarkup = renderToStaticMarkup(
      <html lang="en">
        <head>
          <meta charSet="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Waiting for Approval</title>
          <style dangerouslySetInnerHTML={{ __html: pollingCss }} />
        </head>
        <body>
          <div className="spinner" id="spinner" />
          <h1 id="title">Waiting for Approval</h1>
          <p id="message">Please approve this request on your device.</p>
          <p style={{ marginTop: '4px', fontSize: '0.85em', color: '#808080' }}>
            Client: {clientId}
          </p>
          <script dangerouslySetInnerHTML={{ __html: pollingScript }} />
        </body>
      </html>
    )

    return HttpServerResponse.html(`<!DOCTYPE html>${pollingMarkup}`)
  },
  oauthError: ({ kind, method }) => {
    const message =
      kind === 'unsupported_code_challenge'
        ? `Code Challenge Method '${method ?? ''}' Not Supported`
        : kind === 'invalid_redirect_uri'
          ? 'Invalid redirect_uri'
          : 'Invalid redirect_uri scheme'

    const markup = renderToStaticMarkup(
      <html lang="en">
        <head>
          <meta charSet="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Authorization Error</title>
        </head>
        <body>
          <h1
            id="header"
            style={{ fontSize: kind === 'unsupported_code_challenge' ? '3em' : '2em' }}
          >
            {message}
          </h1>
        </body>
      </html>
    )

    return HttpServerResponse.html(`<!DOCTYPE html>${markup}`)
  },
  pinPage: ({ pin, statusUrl, timeoutMs }) => {
    const pollingScript = `(function() {
  var start = Date.now();
  var TIMEOUT = ${timeoutMs};
  function poll() {
    if (Date.now() - start > TIMEOUT) {
      document.getElementById('spinner').className = 'hidden';
      document.getElementById('pin').className = 'hidden';
      document.getElementById('title').textContent = 'Request Expired';
      document.getElementById('title').className = 'declined';
      document.getElementById('message').textContent = 'The access request has expired. Please try again.';
      return;
    }
    fetch('${statusUrl}')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.status === 'approved' && data.redirect) {
          window.location.href = data.redirect;
        } else if (data.status === 'declined' || data.status === 'error') {
          document.getElementById('spinner').className = 'hidden';
          document.getElementById('pin').className = 'hidden';
          document.getElementById('title').textContent = 'Request Declined';
          document.getElementById('title').className = 'declined';
          document.getElementById('message').textContent = 'The access request was declined.';
        } else if (data.status === 'expired') {
          document.getElementById('spinner').className = 'hidden';
          document.getElementById('pin').className = 'hidden';
          document.getElementById('title').textContent = 'Request Expired';
          document.getElementById('title').className = 'declined';
          document.getElementById('message').textContent = 'The access request has expired. Please try again.';
        } else {
          setTimeout(poll, 1500);
        }
      })
      .catch(function() { setTimeout(poll, 3000); });
  }
  poll();
})();`

    const pollingCss = `body { font-family: system-ui, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; color: #161616; }
.spinner { width: 40px; height: 40px; border: 3px solid #dedede; border-top-color: #3a81d7; border-radius: 50%; animation: spin 0.8s linear infinite; margin-top: 24px; }
@keyframes spin { to { transform: rotate(360deg); } }
h1 { font-size: 1.5em; font-weight: 500; margin-bottom: 8px; }
.pin-code { font-size: 3em; font-weight: 700; letter-spacing: 0.3em; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; margin: 16px 0; color: #161616; }
p { color: #636363; font-size: 1em; }
.declined { color: #c20010; }
.hidden { display: none; }`

    const pollingMarkup = renderToStaticMarkup(
      <html lang="en">
        <head>
          <meta charSet="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Access Request</title>
          <style dangerouslySetInnerHTML={{ __html: pollingCss }} />
        </head>
        <body>
          <h1 id="title">Enter This PIN</h1>
          <div className="pin-code" id="pin">
            {pin}
          </div>
          <p id="message">Approve this request on the device to continue.</p>
          <div className="spinner" id="spinner" />
          <script dangerouslySetInnerHTML={{ __html: pollingScript }} />
        </body>
      </html>
    )

    return HttpServerResponse.html(`<!DOCTYPE html>${pollingMarkup}`)
  },
  pinError: () => {
    const markup = renderToStaticMarkup(
      <html lang="en">
        <head>
          <meta charSet="UTF-8" />
          <title>Error</title>
        </head>
        <body>
          <h1>Invalid returnTo parameter</h1>
        </body>
      </html>
    )

    return HttpServerResponse.html(`<!DOCTYPE html>${markup}`)
  },
}

const AuthRendererLive = Layer.succeed(AuthRenderer, authRenderer)

export { AuthRendererLive }
