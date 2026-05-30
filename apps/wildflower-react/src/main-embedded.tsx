import './instrument.ts'
import { createMemoryHistory } from '@tanstack/react-router'
import { awaitEmbeddedAuthReady } from 'gatekeeper-react'
import 'tundra-css'
import 'react-tundraish/styles.css'
import './styles/global.css'
import { renderApp } from './app-root.tsx'
import { TransportProvider } from './bridges/transport-provider.tsx'

// Embedded WebView: the host delivers the bearer over the gatekeeper
// bridge after `transport.flushed`, so the gate awaits `authTokenRef`
// going non-null for up to 5s before falling through to the timeout
// retry screen.
renderApp({
  history: createMemoryHistory(),
  TransportProvider: TransportProvider,
  entry: 'main-embedded',
  awaitAuthReady: awaitEmbeddedAuthReady,
})
