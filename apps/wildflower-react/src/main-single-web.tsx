// import './instrument.ts'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { createBrowserHistory } from '@tanstack/react-router'
import { makeAwaitWebAuthReady, makeWebAuthTokenStore } from 'gatekeeper-react'
import './styles/global.css'
import { renderApp } from './app-root.tsx'
import { stubTransport } from './bridges/transport-context.ts'

// Same standalone-web auth behavior as `main-web`: localStorage-backed
// `AuthTokenStore` with the `?token=…` URL bootstrap and cross-tab
// sync. Stub transport (pre-resolved).
const tokenStore = makeWebAuthTokenStore()

renderApp({
  history: createBrowserHistory(),
  entry: 'main-single-web',
  tokenStore,
  awaitAuthReady: () => makeAwaitWebAuthReady(tokenStore.subscribable),
  makeTransport: () => Promise.resolve(stubTransport),
})
