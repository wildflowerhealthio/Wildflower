import { initWebTelemetryFromEnv } from 'telemetry-web'
import { writeToken } from './client.ts'

initWebTelemetryFromEnv({ otel: { serviceName: 'gatekeeper-web' } })

// Bootstrap: pull `?token=` from the URL on first load, stash to
// localStorage, and strip from the address bar so it doesn't persist in
// browser history or Referer headers. See gatekeeper-core README's
// "Bootstrap URL" section.
if (typeof window !== 'undefined') {
  const url = new URL(window.location.href)
  const tokenFromUrl = url.searchParams.get('token')
  if (tokenFromUrl !== null && tokenFromUrl !== '') {
    writeToken(tokenFromUrl)
    url.searchParams.delete('token')
    window.history.replaceState(null, '', url.toString())
  }
}
