import './instrument.ts'
import { createMemoryHistory } from '@tanstack/react-router'
import { awaitEmbeddedAuthReady } from 'gatekeeper-react'
import 'tundra-css'
import 'react-tundraish/styles.css'
import './styles/global.css'
import { renderApp } from './app-root.tsx'
import { buildTransport } from './bridges/build-transport.ts'

// Embedded WebView: the host delivers the bearer over the gatekeeper
// bridge after `transport.signalReady`. `awaitEmbeddedAuthReady` is a
// factory that closes over the transport's boot-time `signalReady`
// settled promise — `renderApp` calls it once with that ready
// promise, and the resolved `awaitAuthReady` does the wait inside
// itself before reading the token ref. The transport is built outside
// React; its returned promise feeds `context.transport` for the
// `_auth` loader's `UIReady` emit.
renderApp({
  history: createMemoryHistory(),
  entry: 'main-embedded',
  awaitAuthReady: awaitEmbeddedAuthReady,
  makeTransport: (navigate) => buildTransport(navigate),
})
