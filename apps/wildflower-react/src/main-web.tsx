import './instrument.ts'
import { createBrowserHistory } from '@tanstack/react-router'
import { makeAwaitWebAuthReady, makeWebAuthTokenStore } from 'gatekeeper-react'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { renderApp } from './app-root.tsx'
import './styles/global.css'
import { stubTransport } from './bridges/transport-context.ts'

// Standalone web `AuthTokenStore`: `localStorage`-backed, with the
// `?token=…` URL bootstrap and cross-tab `'storage'` sync. The store
// reads the initial token synchronously at construction time, so the
// gate either resolves immediately (token present) or throws a
// TanStack redirect into the device-login flow (absent) — no waiting.
const tokenStore = makeWebAuthTokenStore()

renderApp({
  history: createBrowserHistory(),
  entry: 'main-web',
  tokenStore,
  // Web ignores transportReady: standalone has no host handshake to
  // wait. The factory shape just keeps the renderApp signature uniform
  // across entries.
  awaitAuthReady: () => makeAwaitWebAuthReady(tokenStore.subscribable),
  // Stub transport: pre-resolved so the `_auth` loader's
  // `await context.transport` is a microtask. `setToken` is ignored
  // (no host bridge to receive `AuthTokenIssued` from).
  makeTransport: () => Promise.resolve(stubTransport),
})
