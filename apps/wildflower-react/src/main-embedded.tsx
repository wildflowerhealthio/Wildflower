import './instrument.ts'
import { createMemoryHistory } from '@tanstack/react-router'
import { awaitEmbeddedAuthReady } from 'gatekeeper-react'
import 'tundra-css'
import 'react-tundraish/styles.css'
import './styles/global.css'
import { renderApp } from './app-root.tsx'
import { buildTransport } from './bridges/build-transport.ts'

// Embedded WebView: the host delivers the bearer over the gatekeeper
// bridge after `transport.signalReady`, so the `_auth` `beforeLoad`
// awaits `transportReady` first and then `awaitEmbeddedAuthReady` (up
// to 5s for the host token) before falling through to the timeout
// retry screen. The transport is built outside React; its
// `flushed → signalReady` chain is what `transportReady` resolves on.
renderApp({
  history: createMemoryHistory(),
  entry: 'main-embedded',
  awaitAuthReady: awaitEmbeddedAuthReady,
  makeTransport: (navigate) => buildTransport(navigate),
})
