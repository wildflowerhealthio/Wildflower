import './instrument.ts'
import { createBrowserHistory } from '@tanstack/react-router'
import { awaitWebAuthReady } from 'gatekeeper-react'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { renderApp } from './app-root.tsx'
import './styles/global.css'
import { stubTransport } from './bridges/transport-context.ts'

// Standalone web: the token is read synchronously from localStorage at
// module load, so the gate resolves immediately (token present) or
// redirects into the device-login flow (absent) — no waiting. The
// stub transport is pre-resolved so `transportReady` is already-resolved.
renderApp({
  history: createBrowserHistory(),
  entry: 'main-web',
  awaitAuthReady: awaitWebAuthReady,
  makeTransport: () => Promise.resolve(stubTransport),
})
