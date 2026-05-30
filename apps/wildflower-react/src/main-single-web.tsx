// import './instrument.ts'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { createBrowserHistory } from '@tanstack/react-router'
import { awaitWebAuthReady } from 'gatekeeper-react'
import './styles/global.css'
import { renderApp } from './app-root.tsx'
import { StubTransportProvider } from './bridges/transport-provider.tsx'

// Same standalone-web auth behavior as `main-web`: synchronous token
// read → gate resolves or redirects immediately.
renderApp({
  history: createBrowserHistory(),
  TransportProvider: StubTransportProvider,
  entry: 'main-single-web',
  awaitAuthReady: awaitWebAuthReady,
})
